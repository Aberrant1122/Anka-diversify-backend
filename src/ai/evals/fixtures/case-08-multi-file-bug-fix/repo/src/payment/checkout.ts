import { createGateway } from "./gateway";

export function processCheckout(apiKey: string) {
  return createGateway({ apiKey, sandbox: true });
}
