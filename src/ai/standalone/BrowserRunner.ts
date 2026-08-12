export class BrowserRunner {
  static async simulateDOMCheck(html: string): Promise<boolean> {
    return html.includes("<!DOCTYPE html>") || html.includes("<html");
  }
}
