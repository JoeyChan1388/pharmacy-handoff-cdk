import { jest } from "@jest/globals";

import type { APIGatewayProxyEvent } from "aws-lambda";

/**
 * Any AWS SDK command: the resolvers only ever inspect `input`.
 */
export interface SentCommand {
  input: Record<string, any>;
  constructor: { name: string };
}

export type AnyMock = jest.Mock<(...args: any[]) => any>;

export type SendHandler = (command: SentCommand) => unknown;

/**
 * Builds an API Gateway event with sensible defaults for a staff caller.
 */
export function makeEvent(
  overrides: Partial<APIGatewayProxyEvent> & { sub?: string } = {},
): APIGatewayProxyEvent {
  const { sub = "staff-1", ...rest } = overrides;
  return {
    httpMethod: "GET",
    headers: {},
    body: null,
    pathParameters: null,
    requestContext: { authorizer: { claims: { sub } } },
    ...rest,
  } as unknown as APIGatewayProxyEvent;
}

/**
 * Routes a DynamoDB document client `send` mock by table name so tests do not
 * depend on call order. Each handler receives the command and returns the
 * result the resolver should see.
 */
export function routeByTable(
  sendMock: AnyMock,
  handlers: Record<string, SendHandler>,
): void {
  sendMock.mockImplementation(async (command: SentCommand) => {
    const table = command.input.TableName as string;
    const handler = handlers[table];
    if (!handler) throw new Error(`Unexpected table: ${table}`);
    return handler(command);
  });
}

/**
 * Routes a Cognito client `send` mock by command class name.
 */
export function routeByCommand(
  sendMock: AnyMock,
  handlers: Record<string, SendHandler>,
): void {
  sendMock.mockImplementation(async (command: SentCommand) => {
    const name = command.constructor.name;
    const handler = handlers[name];
    if (!handler) throw new Error(`Unexpected command: ${name}`);
    return handler(command);
  });
}

/**
 * Returns the commands of a given class name that were sent to a mock.
 */
export function sentCommands(sendMock: AnyMock, name: string): SentCommand[] {
  return sendMock.mock.calls
    .map((call) => call[0] as SentCommand)
    .filter((command) => command.constructor.name === name);
}

/**
 * Builds the error DynamoDB throws when a ConditionExpression fails.
 */
export function conditionalCheckFailed(): Error {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

/**
 * Builds a named AWS SDK error.
 */
export function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

export function parseBody(result: { body?: string }): any {
  return JSON.parse(result.body ?? "{}");
}
