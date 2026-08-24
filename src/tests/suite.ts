import type { TestLogger } from "@paperback/types";

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

export class TestSuite {
  private readonly tests: TestCase[] = [];

  constructor(private readonly name: string, private readonly logger: TestLogger) {
    this.logger.log("name", name);
  }

  test(name: string, run: () => Promise<void>): void {
    this.tests.push({ name, run });
  }

  async run(): Promise<void> {
    const testLogger = this.logger.list("tests");
    let passed = 0;
    let failed = 0;

    for (const test of this.tests) {
      const scopedLogger = testLogger.scope(test.name);
      const startedAt = Date.now();
      try {
        await test.run();
        passed += 1;
        scopedLogger.log("status", "pass");
      } catch (error) {
        failed += 1;
        scopedLogger.log("status", "fail").log("error", String(error));
      }
      scopedLogger.log("duration", Date.now() - startedAt);
    }

    this.logger.log("summary", {
      passed,
      failed,
      total: this.tests.length,
    });
  }
}
