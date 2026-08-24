import { UserDTO } from "../models/user";

export function formatUser(id: string, name: string): UserDTO {
  return {
    id,
    name,
  };
}
