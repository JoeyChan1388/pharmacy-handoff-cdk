import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * DynamoDB Document Client
 *
 * Shared client instance reused across Lambda invocations.
 */
export const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * UpdateExpressionParts
 *
 * The three pieces an UpdateCommand needs to apply a set of field changes.
 */
export interface UpdateExpressionParts {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, string>;
}

/**
 * Builds a SET update expression for the given fields, always bumping
 * `updatedAt` to the current time. Field names are passed through expression
 * attribute names so reserved words such as `name` and `status` are safe.
 *
 * @param updates The fields to set, keyed by attribute name
 * @returns The expression and attribute maps ready to spread into an
 * UpdateCommand
 */
export function buildUpdateExpression(
  updates: Record<string, string>,
): UpdateExpressionParts {
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, string> = {
    ":updatedAt": new Date().toISOString(),
  };
  const assignments = ["#updatedAt = :updatedAt"];

  for (const [field, value] of Object.entries(updates)) {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    assignments.push(`#${field} = :${field}`);
  }

  return {
    UpdateExpression: `SET ${assignments.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/**
 * Checks whether an error is a DynamoDB conditional check failure, which the
 * resolvers use to detect a missing item on update.
 *
 * @param error The caught error
 * @returns True if the condition expression failed
 */
export function isConditionalCheckFailed(error: unknown): boolean {
  return (
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/**
 * Scans all items from a DynamoDB table, handling pagination automatically.
 *
 * @template T The type of the items to be returned.
 * @param tableName The name of the DynamoDB table to scan.
 * @returns A promise that resolves to an array of all items in the table.
 */
export async function scanAll<T>(tableName: string): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

/**
 * Queries all items from a DynamoDB table based on the provided input,
 * handling pagination automatically.
 *
 * @template T The type of the items to be returned.
 * @param input The input parameters for the QueryCommand, excluding
 * ExclusiveStartKey.
 * @returns A promise that resolves to an array of all items matching the
 * query.
 */
export async function queryAll<T>(
  input: Omit<QueryCommandInput, "ExclusiveStartKey">,
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamodb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}
