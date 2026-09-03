import { DatabaseSync } from "node:sqlite";

class PreparedStatement {
  constructor(statement) {
    this.statement = statement;
    this.params = [];
  }

  bind(...params) {
    const next = new PreparedStatement(this.statement);
    next.params = params;
    return next;
  }

  async first() {
    return this.statement.get(...this.params) ?? null;
  }

  async all() {
    return { success: true, results: this.statement.all(...this.params) };
  }

  async run() {
    const result = this.statement.run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

export class SqliteD1 {
  constructor(schema) {
    this.database = new DatabaseSync(":memory:");
    this.database.exec(schema);
  }

  prepare(sql) {
    return new PreparedStatement(this.database.prepare(sql));
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
