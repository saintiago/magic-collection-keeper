/** RDS Data API adapter shared by independently packaged backend runtimes. */

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';

export type DeploymentSqlValue = string | number | boolean | null;
export type DeploymentSqlRow = Readonly<Record<string, DeploymentSqlValue>>;

export interface DeploymentSqlExecutor {
  query(
    statement: string,
    parameters?: Readonly<Record<string, DeploymentSqlValue>>,
  ): Promise<readonly DeploymentSqlRow[]>;
}

export interface DeploymentSqlTransactor extends DeploymentSqlExecutor {
  transaction<T>(work: (statements: DeploymentSqlExecutor) => Promise<T>): Promise<T>;
}

export type DataApiCommandName =
  'ExecuteStatement' | 'BeginTransaction' | 'CommitTransaction' | 'RollbackTransaction';

export interface DataApiCommand {
  readonly name: DataApiCommandName;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface DataApiClient {
  send(command: DataApiCommand): Promise<Readonly<Record<string, unknown>>>;
  destroy?(): void;
}

/** Adapts the AWS client to the small port used by the component compositions. */
export function createRdsDataApiClient(client: RDSDataClient): DataApiClient {
  if (typeof client?.send !== 'function') {
    throw new TypeError('createRdsDataApiClient requires an RDS Data API client.');
  }
  return {
    async send(command): Promise<Readonly<Record<string, unknown>>> {
      switch (command.name) {
        case 'ExecuteStatement':
          return (await client.send(
            new ExecuteStatementCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
        case 'BeginTransaction':
          return (await client.send(
            new BeginTransactionCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
        case 'CommitTransaction':
          return (await client.send(
            new CommitTransactionCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
        case 'RollbackTransaction':
          return (await client.send(
            new RollbackTransactionCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
      }
    },
    destroy() {
      client.destroy();
    },
  };
}

/** Creates the transaction-capable SQL executor the provider contracts consume. */
export function createDataApiTransactor(options: {
  readonly client: DataApiClient;
  readonly resourceArn: string;
  readonly secretArn: string;
  readonly database: string;
}): DeploymentSqlTransactor {
  const client = options?.client;
  if (typeof client?.send !== 'function') {
    throw new TypeError('createDataApiTransactor requires a Data API client.');
  }
  const target = {
    resourceArn: options.resourceArn,
    secretArn: options.secretArn,
    database: options.database,
  };
  const statements = createExecutor(client, target, null);
  return {
    query: statements.query,
    async transaction<T>(work: (statements: DeploymentSqlExecutor) => Promise<T>): Promise<T> {
      const begun = await client.send({ name: 'BeginTransaction', input: { ...target } });
      const transactionId = begun.transactionId;
      if (typeof transactionId !== 'string' || transactionId.length === 0) {
        throw new Error('The RDS Data API did not open the requested transaction.');
      }
      try {
        const result = await work(createExecutor(client, target, transactionId));
        await client.send({ name: 'CommitTransaction', input: { ...target, transactionId } });
        return result;
      } catch (cause) {
        try {
          await client.send({ name: 'RollbackTransaction', input: { ...target, transactionId } });
        } catch {
          // Preserve the operation failure; the abandoned transaction expires server-side.
        }
        throw cause;
      }
    },
  };
}

function createExecutor(
  client: DataApiClient,
  target: { readonly resourceArn: string; readonly secretArn: string; readonly database: string },
  transactionId: string | null,
): DeploymentSqlExecutor {
  return {
    async query(statement, parameters = {}) {
      const response = await client.send({
        name: 'ExecuteStatement',
        input: {
          ...target,
          sql: statement,
          parameters: dataApiParameters(parameters),
          formatRecordsAs: 'JSON',
          includeResultMetadata: false,
          ...(transactionId === null ? {} : { transactionId }),
        },
      });
      return readFormattedRecords(response.formattedRecords);
    },
  };
}

function dataApiParameters(parameters: Readonly<Record<string, DeploymentSqlValue>>) {
  return Object.entries(parameters).map(([name, value]) => ({
    name,
    value:
      value === null
        ? { isNull: true }
        : typeof value === 'string'
          ? { stringValue: value }
          : typeof value === 'boolean'
            ? { booleanValue: value }
            : Number.isInteger(value)
              ? { longValue: value }
              : { doubleValue: value },
  }));
}

function readFormattedRecords(value: unknown): readonly DeploymentSqlRow[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') {
    throw new Error('The RDS Data API returned a result that is not readable.');
  }
  if (value.trim() === '') return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (cause) {
    throw new Error('The RDS Data API returned a result that is not readable.', { cause });
  }
  if (!Array.isArray(decoded)) {
    throw new Error('The RDS Data API returned a result that is not a record list.');
  }
  return decoded.map(readRecord);
}

function readRecord(value: unknown): DeploymentSqlRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The RDS Data API returned a record that is not readable.');
  }
  const record: Record<string, DeploymentSqlValue> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new Error('The RDS Data API returned a column value that is not scalar.');
    }
    record[name] = entry;
  }
  return record;
}
