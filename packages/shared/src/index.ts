export class AppError extends Error { constructor(public readonly code: string, message: string, public readonly rootCause?: unknown) { super(message); } }
export class AuthenticationError extends AppError { constructor(message = "Sua sessão expirou") { super("AUTHENTICATION", message); } }
export class NetworkError extends AppError { constructor(message = "Não foi possível conectar ao serviço") { super("NETWORK", message); } }
export class MediaDeviceError extends AppError { constructor(message: string, cause?: unknown) { super("MEDIA_DEVICE", message, cause); } }

export const logger = {
  info(message: string, context?: Record<string, unknown>) { console.info(message, context ?? {}); },
  warn(message: string, context?: Record<string, unknown>) { console.warn(message, context ?? {}); },
  error(message: string, context?: Record<string, unknown>) { console.error(message, context ?? {}); }
};
