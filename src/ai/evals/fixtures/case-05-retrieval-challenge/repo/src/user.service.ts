export class UserService {
  static getUser(id: string) {
    return { id, name: "Test User" };
  }
}
