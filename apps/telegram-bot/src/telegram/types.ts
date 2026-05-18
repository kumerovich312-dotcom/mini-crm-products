export type TelegramUser = { id: number; username?: string };
export type TelegramChat = { id: number };
export type TelegramPhotoSize = { file_id: string; file_size?: number };
export type TelegramVideo = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
export type TelegramDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
export type TelegramAudio = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
export type TelegramVoice = { file_id: string; mime_type?: string; file_size?: number; duration?: number };
export type TelegramVideoNote = { file_id: string; file_size?: number; duration?: number; length?: number };

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video_note?: TelegramVideoNote;
};

export type TelegramCallbackQuery = { id: string; from: TelegramUser; message?: TelegramMessage; data?: string };
export type TelegramUpdate = { update_id?: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
