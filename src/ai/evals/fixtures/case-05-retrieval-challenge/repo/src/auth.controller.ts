export class AuthController {
  static login(req: any, res: any) {
    return res.json({ token: "sample_token" });
  }

  static logout(req: any, res: any) {
    return res.json({ success: true });
  }
}
