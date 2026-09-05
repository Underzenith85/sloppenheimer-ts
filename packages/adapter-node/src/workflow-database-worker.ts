/**
 * SQLite runs on a dedicated worker so disk locks cannot freeze control or agent deadlines.
 * This source is intentionally dependency-free JavaScript: both source tests and compiled ESM
 * launch the identical worker, without a second TypeScript runtime or package resolution rules.
 */
export const workflowDatabaseWorker = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
// A separate SQLite transaction owns the host lock for this connection's lifetime.
// Kernel file locks disappear on process death; no stale PID or clock-based takeover is needed.
const ownership = workerData.exclusive ? new DatabaseSync(workerData.path + '.owner') : null
if (ownership) {
  ownership.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE')
}
const database = new DatabaseSync(workerData.path)
database.exec('PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
database.exec('CREATE TABLE IF NOT EXISTS workflows (issue_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)')
database.exec('CREATE TABLE IF NOT EXISTS workflow_history (issue_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(issue_id, revision))')
parentPort.on('message', (request) => {
  try {
    let value
    switch (request.kind) {
      case 'get':
        value = database.prepare('SELECT body FROM workflows WHERE issue_id = ?').get(request.issueId)?.body ?? null
        break
      case 'list':
        value = database.prepare('SELECT body FROM workflows ORDER BY issue_id').all().map(row => row.body)
        break
      case 'commit': {
        database.exec('BEGIN IMMEDIATE')
        try {
          const old = database.prepare('SELECT revision FROM workflows WHERE issue_id = ?').get(request.issueId)
          if ((old?.revision ?? null) !== request.expectedRevision) {
            database.exec('ROLLBACK')
            parentPort.postMessage({ id: request.id, ok: false, category: 'conflict' })
            return
          }
          database.prepare('INSERT INTO workflows VALUES (?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET revision = excluded.revision, body = excluded.body')
            .run(request.issueId, request.revision, request.body)
          database.prepare('INSERT INTO workflow_history VALUES (?, ?, ?)').run(request.issueId, request.revision, request.body)
          database.exec('COMMIT')
          value = null
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
        break
      }
      default: throw new Error('Unknown workflow store command')
    }
    parentPort.postMessage({ id: request.id, ok: true, value })
  } catch {
    // SQL/file diagnostics may contain data. The adapter reports field names, not raw messages.
    parentPort.postMessage({ id: request.id, ok: false, category: 'storage' })
  }
})
`
