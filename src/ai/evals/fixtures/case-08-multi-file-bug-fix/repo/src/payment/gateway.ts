export interface GatewayOptions {
  apiKey: string;
  sandbox?: boolean;
}

export function createGateway(opts: GatewayOptions) {
  return opts;
}
