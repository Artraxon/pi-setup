import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getNotificationService } from './service.ts';

export default function notifications(pi: ExtensionAPI) {
    getNotificationService(pi);
}
