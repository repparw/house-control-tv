// Ambient browser globals used by the TV builds. Type-only: Vite never bundles this file.

interface HouseTVBridge {
  getConfig(): string;
  request(id: number, path: string, body: string): void;
  daylight?(): string;
  exit?(): void;
}

interface Window {
  HouseTV?: HouseTVBridge;
  __tvReply?: (id: number, response: { error?: string; [key: string]: unknown }) => void;
  __houseTV?: unknown;
  tvBack?: () => void;
}

interface Navigator {
  deviceMemory?: number;
}

declare var webOS: {
  service?: {
    request(uri: string, options: {
      method: string;
      parameters: object;
      onSuccess(response: { returnValue?: boolean; [key: string]: unknown }): void;
      onFailure(response: { returnValue?: boolean; errorCode?: number; errorText?: string }): void;
    }): { cancel(): void };
  };
} | undefined;
