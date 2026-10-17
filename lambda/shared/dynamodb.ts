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
 * @param input The input parameters for the QueryCommand, excluding ExclusiveStartKey.
 * @returns A promise that resolves to an array of all items matching the query.
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
