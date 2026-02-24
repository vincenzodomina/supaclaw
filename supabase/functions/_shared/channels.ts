export type ChannelUpdate = {
  update_id: number | string;
  message?: ChannelMessage;
  edited_message?: ChannelMessage;
};

export type ChannelDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type ChannelPhoto = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type ChannelMessage = {
  message_id: number | string;
  from?: { id: number | string };
  chat: { id: number | string; type: string };
  text?: string;
  caption?: string;
  document?: ChannelDocument;
  photo?: ChannelPhoto[];
};

export type ChannelAttachment = {
  fileId: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  caption?: string;
};

export function getChannelAttachment(
  message: ChannelMessage,
): ChannelAttachment | undefined {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? "document",
      mimeType: message.document.mime_type,
      size: message.document.file_size,
      caption: message.caption,
    };
  }
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      size: largest.file_size,
      caption: message.caption,
    };
  }
  return undefined;
}
