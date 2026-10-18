/**
 * The farms table in DynamoDB, when the store is told to use one.
 *
 * The file in store.ts is one process on one machine: a second copy of the server
 * cannot share it, and the scheduled alert check in sweep.ts runs somewhere else
 * entirely. So with ORBITA_STORE=dynamodb every farm is one item, keyed by its id.
 *
 *   id     the farm id, as the store uses it
 *   body   the record as JSON, sealed with the data key when one is set (vault.ts)
 *   v      a version number, raised by one on every write
 *   ttl    for sandbox records only: when DynamoDB itself may delete it (seconds)
 *
 * Every write says which version it read. If somebody else wrote in between, the
 * write is refused rather than quietly replacing theirs, and store.ts starts again
 * from what is there now. That is the whole of the concurrency story, and it is
 * enough for two writers that touch the same farm rarely.
 *
 * Nothing here knows what a farm is. It moves strings.
 */

import {
  DynamoDBClient,
  ScanCommand,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';

export type Item = { id: string; body: string; v: number };

/** The few calls the store makes, so a test can stand in for DynamoDB. */
export type Backend = {
  scan(): Promise<Item[]>;
  get(id: string): Promise<Item | null>;
  /** False when the version on the table is not the one expected. */
  put(item: Item, expected: number, ttl: number | null): Promise<boolean>;
  remove(id: string): Promise<void>;
};

export const tableName = (): string => process.env.ORBITA_TABLE ?? 'orbita-farms';
export const tableOn = (): boolean => (process.env.ORBITA_STORE ?? 'file').toLowerCase() === 'dynamodb';

const toItem = (r: Record<string, AttributeValue> | undefined): Item | null =>
  r?.id?.S != null && r.body?.S != null ? { id: r.id.S, body: r.body.S, v: Number(r.v?.N ?? 0) } : null;

function dynamo(): Backend {
  // An endpoint for DynamoDB Local in docker-compose.yml. Unset on AWS.
  const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1', ...(process.env.ORBITA_DYNAMO_ENDPOINT ? { endpoint: process.env.ORBITA_DYNAMO_ENDPOINT } : {}) });
  const TableName = tableName();
  return {
    async scan() {
      const out: Item[] = [];
      let start: Record<string, AttributeValue> | undefined;
      do {
        // Consistent, because this is the read a restart is built from.
        const page = await client.send(new ScanCommand({ TableName, ConsistentRead: true, ExclusiveStartKey: start }));
        for (const r of page.Items ?? []) {
          const item = toItem(r);
          if (item) out.push(item);
        }
        start = page.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async get(id) {
      const r = await client.send(new GetItemCommand({ TableName, Key: { id: { S: id } }, ConsistentRead: true }));
      return toItem(r.Item);
    },
    async put(item, expected, ttl) {
      try {
        await client.send(
          new PutItemCommand({
            TableName,
            Item: { id: { S: item.id }, body: { S: item.body }, v: { N: String(item.v) }, ...(ttl != null ? { ttl: { N: String(ttl) } } : {}) },
            ConditionExpression: expected === 0 ? 'attribute_not_exists(id)' : 'v = :v',
            ...(expected === 0 ? {} : { ExpressionAttributeValues: { ':v': { N: String(expected) } } }),
          }),
        );
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async remove(id) {
      await client.send(new DeleteItemCommand({ TableName, Key: { id: { S: id } } }));
    },
  };
}

let backend: Backend | null = null;
export const table = (): Backend => (backend ??= dynamo());

/** For tests: an in-memory table with the same version rule. Null puts DynamoDB back. */
export function configureForTest(b: Backend | null): void {
  backend = b;
}

/** The same rules as the real table, in a Map. Exported so the tests and the sweep test share one. */
export function memoryTable(): Backend & { rows: Map<string, Item & { ttl: number | null }> } {
  const rows = new Map<string, Item & { ttl: number | null }>();
  return {
    rows,
    async scan() {
      return [...rows.values()].map(({ id, body, v }) => ({ id, body, v }));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { id: r.id, body: r.body, v: r.v } : null;
    },
    async put(item, expected, ttl) {
      const held = rows.get(item.id);
      if (expected === 0 ? held != null : held?.v !== expected) return false;
      rows.set(item.id, { ...item, ttl });
      return true;
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}
