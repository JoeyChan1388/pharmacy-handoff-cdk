import { jest } from "@jest/globals";
import {
  type AnyMock,
  makeEvent,
  parseBody,
  routeByTable,
  sentCommands,
} from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

process.env.PLATFORM_ADMIN_USER_IDS = "platform-admin";

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler as staffHandler } from "../lambda/messaging/staffAlertsResolver";
import { handler as platformHandler } from "../lambda/platform/manageAlertsResolver";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;

const event = (
  httpMethod: string,
  resource: string,
  extra: Record<string, unknown> = {},
  sub = "u1",
) => makeEvent({ sub, httpMethod, resource, ...extra } as never);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ALERTS_TABLE_NAME = "alerts";
  process.env.ALERT_RECEIPTS_TABLE_NAME = "receipts";
});

describe("staff alerts", () => {
  const alerts = [
    {
      feed: "ALERTS",
      alertId: "002",
      title: "B",
      body: "b",
      severity: "danger",
      createdBy: "admin",
      createdAt: "t2",
    },
    {
      feed: "ALERTS",
      alertId: "001",
      title: "A",
      body: "a",
      severity: "info",
      createdBy: "admin",
      createdAt: "t1",
    },
  ];

  test("lists alerts with per-user read state and hides the sender", async () => {
    routeByTable(sendMock, { alerts: () => ({ Items: alerts }) });
    queryAllMock.mockResolvedValue([{ alertId: "001" }]);

    const response = await staffHandler(event("GET", "/staff/me/alerts"));
    const body = parseBody(response);

    expect(body.alerts).toEqual([
      {
        alertId: "002",
        title: "B",
        body: "b",
        severity: "danger",
        createdAt: "t2",
        read: false,
      },
      {
        alertId: "001",
        title: "A",
        body: "a",
        severity: "info",
        createdAt: "t1",
        read: true,
      },
    ]);
    const [query] = sentCommands(sendMock, "QueryCommand");
    expect(query.input.ScanIndexForward).toBe(false);
  });

  test("marks one alert read", async () => {
    routeByTable(sendMock, {
      alerts: () => ({ Item: alerts[0] }),
      receipts: () => ({}),
    });

    const response = await staffHandler(
      event("POST", "/staff/me/alerts/{alertId}/read", {
        pathParameters: { alertId: "002" },
      }),
    );

    expect(response.statusCode).toBe(200);
    const [put] = sentCommands(sendMock, "PutCommand");
    expect(put.input).toMatchObject({
      TableName: "receipts",
      Item: { userId: "u1", alertId: "002" },
    });
  });

  test("404s when marking an unknown alert", async () => {
    routeByTable(sendMock, { alerts: () => ({}) });

    const response = await staffHandler(
      event("POST", "/staff/me/alerts/{alertId}/read", {
        pathParameters: { alertId: "nope" },
      }),
    );

    expect(response.statusCode).toBe(404);
  });

  test("marks an alert unread by deleting the receipt", async () => {
    sendMock.mockResolvedValue({});

    const response = await staffHandler(
      event("DELETE", "/staff/me/alerts/{alertId}/read", {
        pathParameters: { alertId: "002" },
      }),
    );

    expect(response.statusCode).toBe(200);
    const [del] = sentCommands(sendMock, "DeleteCommand");
    expect(del.input).toMatchObject({
      TableName: "receipts",
      Key: { userId: "u1", alertId: "002" },
    });
  });

  test("read-all only writes receipts for unread alerts", async () => {
    routeByTable(sendMock, {
      alerts: () => ({ Items: alerts }),
      receipts: () => ({}),
    });
    queryAllMock.mockResolvedValue([{ alertId: "001" }]);

    await staffHandler(event("POST", "/staff/me/alerts/read-all"));

    const puts = sentCommands(sendMock, "PutCommand");
    expect(puts).toHaveLength(1);
    expect(puts[0].input.Item.alertId).toBe("002");
  });
});

describe("platform alerts", () => {
  const send = (body: unknown, sub = "platform-admin") =>
    platformHandler(
      event("POST", "/platform/alerts", { body: JSON.stringify(body) }, sub),
    );

  test("rejects non-admins", async () => {
    const response = await send({ title: "t", body: "b" }, "someone");

    expect(response.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("stores one alert for everyone, defaulting severity to info", async () => {
    sendMock.mockResolvedValue({});

    const response = await send({ title: " Outage ", body: "System down" });
    const body = parseBody(response);

    expect(response.statusCode).toBe(201);
    expect(body.alert).toMatchObject({
      feed: "ALERTS",
      title: "Outage",
      severity: "info",
      createdBy: "platform-admin",
    });
    expect(sentCommands(sendMock, "PutCommand")).toHaveLength(1);
  });

  test("validates title, body and severity", async () => {
    for (const body of [
      { body: "b" },
      { title: "t" },
      { title: "x".repeat(121), body: "b" },
      { title: "t", body: "b", severity: "critical" },
    ]) {
      expect((await send(body)).statusCode).toBe(400);
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("lists sent alerts newest first", async () => {
    routeByTable(sendMock, { alerts: () => ({ Items: [{ alertId: "1" }] }) });

    const response = await platformHandler(
      event("GET", "/platform/alerts", {}, "platform-admin"),
    );

    expect(parseBody(response).alerts).toEqual([{ alertId: "1" }]);
  });
});
