import { registerHandler } from "./handler.registry.js";
import { emailHandler } from "./handlers/email.handler.js";

registerHandler("test.email", emailHandler);