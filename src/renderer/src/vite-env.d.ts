/// <reference types="vite/client" />

import type { ClawInboxApi } from '../../shared/types';

declare global {
  interface Window {
    clawInbox: ClawInboxApi;
  }
}

