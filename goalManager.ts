import { Database } from "sqlite3";
import fs from "node:fs";
import path from "node:path";

export const GOALS_DB_FILENAME = "goals.sqlite";

export type GoalTask = {
  id: number;
  text: string;
  isComplete: boolean;
  createdAt: string;
  completedAt: string | null;
};

export type GoalJson = {
  goal: string;
  createdAt: string;
  lastUpdatedAt: string;
  completedAt: string | null;
  completionSummary: string | null;
  totalDuration: number;
  isActive: boolean;
  tasks: GoalTask[];
};

export type GoalToolDetails = {
  goal: GoalJson | null;
  error?: string;
};

type GoalRow = {
  goal: string;
  created_at: string;
  last_updated_at: string;
  completed_at: string | null;
  completion_summary: string | null;
  total_duration: number;
  is_active: number;
};

type GoalTaskRow = {
  id: number;
  text: string;
  is_complete: number;
  created_at: string;
  completed_at: string | null;
};

export type GoalManager = {
  readonly dbPath: string;
  createGoal(sessionId: string, goalText: string): Promise<GoalJson>;
  saveGoal(sessionId: string, goal: GoalJson): Promise<void>;
  loadGoal(sessionId: string): Promise<GoalJson | null>;
  goalToJson(sessionId: string): Promise<string | null>;
  close(): Promise<void>;
};

export type GoalManagerOptions = {
  dbFileName?: string;
  now?: () => string;
};

const defaultNow = () => Date.now().toFixed(0).toString();

const toStoredBoolean = (value: boolean) => (value ? 1 : 0);
const fromStoredBoolean = (value: number) => value !== 0;
type SqliteValue = string | number | null;

export const createGoalManager = (
  goalsDir: string,
  options: GoalManagerOptions = {},
): GoalManager => {
  fs.mkdirSync(goalsDir, { recursive: true });

  const dbPath = path.join(goalsDir, options.dbFileName ?? GOALS_DB_FILENAME);
  const db = new Database(dbPath);
  const now = options.now ?? defaultNow;
  let isClosed = false;
  let operationQueue = Promise.resolve();

  db.configure("busyTimeout", 5000);

  const ensureOpen = () => {
    if (isClosed) throw new Error("GoalManager is closed");
  };

  const exec = (sql: string) =>
    new Promise<void>((resolve, reject) => {
      ensureOpen();
      db.exec(sql, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  const run = (sql: string, params: SqliteValue[] = []) =>
    new Promise<void>((resolve, reject) => {
      ensureOpen();
      db.run(sql, params, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  const get = <T>(sql: string, params: SqliteValue[] = []) =>
    new Promise<T | undefined>((resolve, reject) => {
      ensureOpen();
      db.get<T>(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(row);
      });
    });

  const all = <T>(sql: string, params: SqliteValue[] = []) =>
    new Promise<T[]>((resolve, reject) => {
      ensureOpen();
      db.all<T>(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(rows ?? []);
      });
    });

  const ready = exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS goals (
      session_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      completed_at TEXT,
      completion_summary TEXT,
      total_duration INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS goal_tasks (
      session_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      text TEXT NOT NULL,
      is_complete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (session_id, id),
      FOREIGN KEY (session_id) REFERENCES goals(session_id) ON DELETE CASCADE
    );
  `);

  const enqueueOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const saveGoalTransaction = (sessionId: string, goal: GoalJson) =>
    enqueueOperation(async () => {
      await ready;
      await exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        await run(
          `INSERT INTO goals (
            session_id,
            goal,
            created_at,
            last_updated_at,
            completed_at,
            completion_summary,
            total_duration,
            is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            goal = excluded.goal,
            created_at = excluded.created_at,
            last_updated_at = excluded.last_updated_at,
            completed_at = excluded.completed_at,
            completion_summary = excluded.completion_summary,
            total_duration = excluded.total_duration,
            is_active = excluded.is_active`,
          [
            sessionId,
            goal.goal,
            goal.createdAt,
            goal.lastUpdatedAt,
            goal.completedAt,
            goal.completionSummary,
            goal.totalDuration,
            toStoredBoolean(goal.isActive),
          ],
        );

        await run("DELETE FROM goal_tasks WHERE session_id = ?", [sessionId]);
        for (const task of goal.tasks) {
          await run(
            `INSERT INTO goal_tasks (
              session_id,
              id,
              text,
              is_complete,
              created_at,
              completed_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              sessionId,
              task.id,
              task.text,
              toStoredBoolean(task.isComplete),
              task.createdAt,
              task.completedAt,
            ],
          );
        }

        await exec("COMMIT");
      } catch (error) {
        await exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });

  const loadGoal = async (sessionId: string): Promise<GoalJson | null> =>
    enqueueOperation(async () => {
      await ready;
      const goalRow = await get<GoalRow>(
        `SELECT
          goal,
          created_at,
          last_updated_at,
          completed_at,
          completion_summary,
          total_duration,
          is_active
        FROM goals
        WHERE session_id = ?`,
        [sessionId],
      );

      if (!goalRow) return null;

      const taskRows = await all<GoalTaskRow>(
        `SELECT
          id,
          text,
          is_complete,
          created_at,
          completed_at
        FROM goal_tasks
        WHERE session_id = ?
        ORDER BY id ASC`,
        [sessionId],
      );

      return {
        goal: goalRow.goal,
        createdAt: goalRow.created_at,
        lastUpdatedAt: goalRow.last_updated_at,
        completedAt: goalRow.completed_at,
        completionSummary: goalRow.completion_summary,
        totalDuration: goalRow.total_duration,
        isActive: fromStoredBoolean(goalRow.is_active),
        tasks: taskRows.map((taskRow) => ({
          id: taskRow.id,
          text: taskRow.text,
          isComplete: fromStoredBoolean(taskRow.is_complete),
          createdAt: taskRow.created_at,
          completedAt: taskRow.completed_at,
        })),
      };
    });

  return {
    dbPath,

    async createGoal(sessionId: string, goalText: string) {
      const timestamp = now();
      const goal: GoalJson = {
        goal: goalText,
        createdAt: timestamp,
        lastUpdatedAt: timestamp,
        completedAt: null,
        completionSummary: null,
        totalDuration: 0,
        isActive: true,
        tasks: [],
      };
      await saveGoalTransaction(sessionId, goal);
      return goal;
    },

    async saveGoal(sessionId: string, goal: GoalJson) {
      await saveGoalTransaction(sessionId, goal);
    },

    loadGoal,

    async goalToJson(sessionId: string) {
      const goal = await loadGoal(sessionId);
      return goal ? JSON.stringify(goal, null, 2) : null;
    },

    async close() {
      if (isClosed) return;
      await operationQueue;
      await ready.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        db.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      isClosed = true;
    },
  };
};
