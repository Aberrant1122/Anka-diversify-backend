import { TerminalSessionManager } from "../terminal-session-manager";
import { ProjectRepositoryService } from "../project-repository-service";
import childProcess from "child_process";

// The historical host-shell contract is intentionally replaced by fail-closed
// behavior. Re-enabling it requires a separate isolated execution design.
describe("terminal isolation boundary", () => {
  afterEach(() => { TerminalSessionManager.resetInstance(); jest.restoreAllMocks(); });
  it("rejects session creation before repository lookup", async () => {
    const lookup = jest.spyOn(ProjectRepositoryService.prototype, "list");
    await expect(TerminalSessionManager.getInstance().createSession("project", "repo"))
      .rejects.toThrow("TERMINAL_ISOLATION_REQUIRED");
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(["pwd", "node -e process.exit(0)", "echo hello", ""])("rejects direct execution of %s without spawning", async (command) => {
    const spawn = jest.spyOn(childProcess, "spawn");
    const output = jest.fn();
    await expect(TerminalSessionManager.getInstance().runCommand("session", "project", command, output, output))
      .rejects.toThrow("TERMINAL_ISOLATION_REQUIRED");
    expect(spawn).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });
});
