import { demoBackend } from './runtime.js';

export const invoke = (command, args = {}) => demoBackend.invoke(command, args);
