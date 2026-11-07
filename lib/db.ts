// Aurora PostgreSQL through the RDS Data API (IMPLEMENTATION section 3): SQL over HTTPS, no VPC or connection pool
import "server-only";
import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";

export type Param = SqlParameter;

/**
 * Parameter builders. uuids, timestamps and dates are sent as text and cast in SQL
 * (CAST(:id AS uuid), CAST(:at AS timestamptz)), so no session time zone or typeHint is involved.
 */
export const p = {
  text: (name: string, value: string | null): Param =>
    value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value } },
  uuid: (name: string, value: string): Param => ({ name, value: { stringValue: value } }),
  ts: (name: string, value: Date | null): Param =>
    value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value.toISOString() } },
  bool: (name: string, value: boolean): Param => ({ name, value: { booleanValue: value } }),
  int: (name: string, value: number): Param => ({ name, value: { longValue: Math.trunc(value) } }),
  bytes: (name: string, value: Uint8Array): Param => ({ name, value: { blobValue: value } }),
};

export interface SqlRunner {
  /** rows of a SELECT or a RETURNING clause; name every column, never SELECT * on tables with embeddings */
  query<T>(sql: string, params?: Param[]): Promise<T[]>;
  /** number of rows changed */
  execute(sql: string, params?: Param[]): Promise<number>;
}

export interface Database extends SqlRunner {
  /** runs work in one Data API transaction; commits on success, rolls back on any error and rethrows it */
  transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export interface DbConfig {
  resourceArn: string;
  secretArn: string;
  database: string;
  region: string;
}

/** minimal client surface, so tests can pass a fake */
export interface DataApiClient {
  send(command: unknown): Promise<unknown>;
}

/** an error safe to log: AWS error name only, never SQL text, parameters or provider messages */
export class DatabaseError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`database error: ${code}`);
    this.name = "DatabaseError";
    this.code = code;
  }
}

const RESUME_RETRIES = 3;
const RESUME_WAIT_MS = 10_000;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const resourceArn = env.DB_CLUSTER_ARN;
  const secretArn = env.DB_SECRET_ARN;
  if (!resourceArn || !secretArn) {
    throw new DatabaseError("not_configured");
  }
  return {
    resourceArn,
    secretArn,
    database: env.DB_NAME ?? "reliefready",
    region: env.APP_AWS_REGION ?? "us-east-2",
  };
}

export function createDatabase(
  config: DbConfig,
  client: DataApiClient = new RDSDataClient({ region: config.region }),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Database {
  const base = { resourceArn: config.resourceArn, secretArn: config.secretArn, database: config.database };

  // an auto-paused Aurora Serverless v2 cluster takes about 15 to 30 seconds to resume (IMPLEMENTATION section 3)
  async function send<T>(command: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await client.send(command)) as T;
      } catch (error) {
        const name = (error as { name?: string }).name ?? "UnknownError";
        if (name === "DatabaseResumingException" && attempt < RESUME_RETRIES) {
          await wait(RESUME_WAIT_MS);
          continue;
        }
        throw new DatabaseError(name);
      }
    }
  }

  function runner(transactionId?: string): SqlRunner {
    return {
      async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
        const out = await send<{ formattedRecords?: string }>(
          new ExecuteStatementCommand({ ...base, sql, parameters: params, transactionId, formatRecordsAs: "JSON" }),
        );
        return out.formattedRecords ? (JSON.parse(out.formattedRecords) as T[]) : [];
      },
      async execute(sql: string, params: Param[] = []): Promise<number> {
        const out = await send<{ numberOfRecordsUpdated?: number }>(
          new ExecuteStatementCommand({ ...base, sql, parameters: params, transactionId }),
        );
        return out.numberOfRecordsUpdated ?? 0;
      },
    };
  }

  return {
    ...runner(),
    async transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> {
      const begun = await send<{ transactionId?: string }>(new BeginTransactionCommand(base));
      const transactionId = begun.transactionId;
      if (!transactionId) {
        throw new DatabaseError("no_transaction_id");
      }
      let result: T;
      try {
        result = await work(runner(transactionId));
      } catch (error) {
        try {
          await send(new RollbackTransactionCommand({ resourceArn: base.resourceArn, secretArn: base.secretArn, transactionId }));
        } catch {
          // the original error matters more; Data API also ends an abandoned transaction after its timeout
        }
        throw error;
      }
      await send(new CommitTransactionCommand({ resourceArn: base.resourceArn, secretArn: base.secretArn, transactionId }));
      return result;
    },
  };
}

let shared: Database | undefined;

/** the app-wide database from env; throws DatabaseError("not_configured") until DB_CLUSTER_ARN and DB_SECRET_ARN are set */
export function db(): Database {
  shared ??= createDatabase(configFromEnv());
  return shared;
}
