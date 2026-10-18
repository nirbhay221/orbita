/**
 * Orbita's AWS resources, as code.
 *
 *   The farms table       one item per farm (src/table.ts), on-demand, point-in-time
 *                         recovery on, and a TTL attribute so a sandbox record is
 *                         deleted by DynamoDB itself after seven days.
 *   The alert check       src/sweep.ts, as a Lambda container image built from the
 *                         repository's own Dockerfile (target `sweep`).
 *   Every 15 minutes      EventBridge Scheduler starts it. One at a time: it times out at five
 *                         minutes and is never retried, so a run is over before the next can start
 *                         and two can never email the same crew. (Reserving a concurrency of
 *                         one would say the same, but a new account has too little to reserve.)
 *   An alarm              when the check fails, or stops running at all. The alerts are
 *                         the part of Orbita nobody is there to watch, so something has to.
 *
 * The server itself stays where it is (deploy/). This stack gives its existing instance
 * role access to the table, when told the role's name, and the server is switched over
 * with ORBITA_STORE=dynamodb and ORBITA_ALERTS=scheduler.
 *
 * Nothing account specific is written here. What differs per deployment comes in as
 * context at deploy time:
 *
 *   publicUrl     the server's public address, for the stop link in every email (required)
 *   serverRole    the server instance's IAM role name, to be given access to the table
 *   alarmEmail    who hears when the check is failing
 *   emailFrom     the SES identity alerts are sent from, to scope the send permission
 */

import { Duration, RemovalPolicy, Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type OrbitaProps = StackProps & {
  publicUrl: string;
  serverRole?: string;
  alarmEmail?: string;
  emailFrom?: string;
  /** Where the repository's Dockerfile is. Defaults to the folder above infra/. */
  repoRoot?: string;
  /** Parameter Store prefix the data key and sender live under, as on the server. */
  params?: string;
};

export class OrbitaStack extends Stack {
  constructor(scope: Construct, id: string, props: OrbitaProps) {
    super(scope, id, props);
    const params = props.params ?? '/orbita';

    const farms = new dynamodb.Table(this, 'Farms', {
      tableName: 'orbita-farms',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      // Customer data. Deleting the stack must never delete the farms in it.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const root = props.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const logGroup = new logs.LogGroup(this, 'SweepLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const sweep = new lambda.DockerImageFunction(this, 'Sweep', {
      description: 'Orbita: the scheduled alert check (src/sweep.ts)',
      code: lambda.DockerImageCode.fromImageAsset(root, {
        target: 'sweep',
        platform: Platform.LINUX_AMD64,
        // What goes into the build is set by the repository's .dockerignore.
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      logGroup,
      environment: {
        ORBITA_STORE: 'dynamodb',
        ORBITA_TABLE: farms.tableName,
        ORBITA_PARAMS: params,
        ORBITA_REQUIRE_ENCRYPTION: 'on',
        ORBITA_PUBLIC_URL: props.publicUrl,
      },
    });
    farms.grantReadWriteData(sweep);

    // The same parameters orbita-secrets.sh reads for the server. Read only, and only these.
    sweep.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: ['data-key', 'data-key-previous', 'email-from'].map((n) =>
          this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${params.replace(/^\//, '')}/${n}` }),
        ),
      }),
    );
    // Email from the one verified sender, when it is named; otherwise from any identity in this account.
    sweep.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: props.emailFrom ?? '*' })],
      }),
    );

    new scheduler.Schedule(this, 'EveryFifteenMinutes', {
      description: 'Orbita: run the alert check',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(15)),
      // A missed run is caught by the next one fifteen minutes later. Retrying would only queue behind it.
      target: new targets.LambdaInvoke(sweep, { retryAttempts: 0, maxEventAge: Duration.minutes(14) }),
    });

    const topic = new sns.Topic(this, 'Alarms', { displayName: 'Orbita alert check' });
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const failing = new cloudwatch.Alarm(this, 'SweepFailing', {
      alarmDescription: 'The scheduled alert check failed twice in a row. Crews may not be getting storm warnings.',
      metric: sweep.metricErrors({ period: Duration.minutes(15), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // An absence produces no error. So the alarm also fires when the check simply has not run for 45 minutes.
    const silent = new cloudwatch.Alarm(this, 'SweepNotRunning', {
      alarmDescription: 'The scheduled alert check has not run for 45 minutes.',
      metric: sweep.metricInvocations({ period: Duration.minutes(45), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    for (const a of [failing, silent]) a.addAlarmAction(new actions.SnsAction(topic));

    if (props.serverRole) {
      // Named for this project: the policy CDK attaches takes its name from this id, and Sudor's stack
      // grants the same server role under 'ServerRole'. Two policies of one name on one role is refused.
      const server = iam.Role.fromRoleName(this, 'OrbitaServerRole', props.serverRole);
      farms.grantReadWriteData(server);
    }

    new CfnOutput(this, 'TableName', { value: farms.tableName });
    new CfnOutput(this, 'SweepFunction', { value: sweep.functionName });
  }
}
