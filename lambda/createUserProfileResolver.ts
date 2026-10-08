import type { PostConfirmationTriggerEvent } from "aws-lambda";

export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => event;