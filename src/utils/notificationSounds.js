// Built-in macOS sounds, resolved by name by the native notification service.
export const NOTIFICATION_SOUNDS = ['Glass', 'Ping', 'Pop', 'Purr', 'Tink'];

export const normalizeNotificationSound = (sound) =>
  NOTIFICATION_SOUNDS.includes(sound) ? sound : 'none';
