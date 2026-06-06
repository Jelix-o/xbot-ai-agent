import type { MessageImageInput, MessageSegment, ParsedPrivateMessage } from "../types.js";

export function parsePrivateMessage(message: MessageSegment[] | string): ParsedPrivateMessage {
  if (typeof message === "string") {
    return { text: message.trim(), images: [] };
  }

  const textParts: string[] = [];
  const images: MessageImageInput[] = [];
  for (const segment of message) {
    if (typeof segment === "string") {
      textParts.push(segment);
      continue;
    }
    if (segment.type === "text" && segment.data?.text) {
      textParts.push(segment.data.text);
    }
    if (segment.type === "image") {
      images.push({
        url: segment.data?.url,
        file: segment.data?.file,
        summary: segment.data?.summary,
      });
    }
  }

  return {
    text: textParts.join("").trim(),
    images: images.filter((image) => image.url || image.file || image.summary),
  };
}

export function extractCommandText(message: MessageSegment[] | string): string {
  return parsePrivateMessage(message).text.trim();
}
