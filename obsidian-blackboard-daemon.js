const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const chokidar = require('chokidar');
const path = require('path');

// 绝对路径配置
const USER_HOME = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(USER_HOME, '.openclaw');
const VAULT_ROOT =
  process.env.AI_MEMORY_OBSIDIAN_VAULT ||
  process.env.OBSIDIAN_VAULT_ROOT ||
  path.join(USER_HOME, 'Documents', 'Obsidian Vault');
const DB_PATH =
  process.env.OPENCLAW_BLACKBOARD_DB || path.join(OPENCLAW_HOME, 'workspace', 'ai-shrimp', 'blackboard', 'tasks.db');
const MD_PATH = path.join(VAULT_ROOT, '02-KB', 'WORKING.md');
const START_TAG = '<!-- OPENCLAW-BLACKBOARD:START -->';
const END_TAG = '<!-- OPENCLAW-BLACKBOARD:END -->';

// 建立 SQLite 连接
const db = new sqlite3.Database(DB_PATH);

// 互斥锁，避免 fs.watch 和脚本写入互相死循环
let isUpdating = false;

function syncDbToMd() {
    if (isUpdating) return;
    
    // 查询最近的 15 个活跃任务
    db.all("SELECT id, repo, issue_number, state, assigned_agent FROM tasks WHERE state != 'ABORTED' ORDER BY id DESC LIMIT 15", (err, rows) => {
        if (err) {
            console.error('[Daemon] DB read error:', err.message);
            return;
        }
        
        let lines = [
            START_TAG, 
            `### 🍤 AI Shrimp Tasks Blackboard`, 
            `*Auto-synced with OpenClaw SQLite*`, 
            ``
        ];
        
        rows.forEach(r => {
            // 如果是 PENDING/PROCESSING，就是空框框；如果是 PR_SUBMITTED/FAILED 就是勾选状态
            const isDone = ['PR_SUBMITTED', 'FAILED'].includes(r.state) ? 'x' : ' ';
            const icon = r.state === 'PROCESSING' ? '⚙️' : (r.state === 'PR_SUBMITTED' ? '✅' : '⏳');
            lines.push(`- [${isDone}] [${icon} ${r.state}] repo: ${r.repo} #${r.issue_number} (assignee: ${r.assigned_agent || 'unassigned'}) <!--#OC-TASK-${r.id}-->`);
        });
        lines.push(END_TAG);
        
        try {
            if (!fs.existsSync(MD_PATH)) return;

            let content = fs.readFileSync(MD_PATH, 'utf8');
            const blockRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, 'm');
            
            const newBlockText = lines.join('\n');
            let newContent;

            // 替换或追加
            if (blockRegex.test(content)) {
                newContent = content.replace(blockRegex, newBlockText);
            } else {
                newContent = content + '\n\n' + newBlockText + '\n';
            }
            
            // 只有当有实质性改变才写入，避免无效触发 fs.watch
            if (content !== newContent) {
                isUpdating = true;
                fs.writeFileSync(MD_PATH, newContent, 'utf8');
                console.log(`[Daemon] Synced DB -> MD (Updated ${rows.length} tasks to visual UI)`);
                // 让文件系统喘口气，再释放锁
                setTimeout(() => isUpdating = false, 1000);
            }
        } catch (e) {
            console.error('[Daemon] MD read/write error:', e.message);
        }
    });
}

function handleMdChange() {
    if (isUpdating) return;
    try {
        const content = fs.readFileSync(MD_PATH, 'utf8');
        const blockRegex = new RegExp(`${START_TAG}([\\s\\S]*?)${END_TAG}`, 'm');
        const match = content.match(blockRegex);
        if (!match) return;
        
        const lines = match[1].split('\n');
        const tasksToComplete = [];
        
        lines.forEach(line => {
            // 捕获用户在 Obsidian 里面打上的勾： - [x] ... <!--#OC-TASK-123-->
            const taskMatch = line.match(/- \[(x|X)\] .*<!--#OC-TASK-(\d+)-->/);
            if (taskMatch) {
                const taskId = parseInt(taskMatch[2], 10);
                tasksToComplete.push(taskId);
            }
        });
        
        if (tasksToComplete.length > 0) {
            const placeholders = tasksToComplete.map(() => '?').join(',');
            // 只更新那些状态还没有终结的任​​务
            const q = `UPDATE tasks SET state='PR_SUBMITTED' WHERE id IN (${placeholders}) AND state NOT IN ('PR_SUBMITTED', 'FAILED', 'ABORTED')`;
            db.run(q, tasksToComplete, function(err) {
                if (err) return console.error('[Daemon] DB Update err:', err);
                if (this.changes > 0) {
                    console.log(`[Daemon] Human/Agent UI marked ${this.changes} tasks as done. Emitted to SQLite.`);
                    // UI 反推数据库成功后，我们立即查一遍数据库重新渲染 MD，以保证格式严格对齐
                    syncDbToMd();
                }
            });
        }
    } catch (e) {
        console.error('[Daemon] MD change handling error:', e.message);
    }
}

console.log("==================================================");
console.log("🚀 Omni-Memory Mesh: Blackboard <-> Obsidian Daemon ");
console.log("==================================================");

// 首次启动时主动对齐一次
syncDbToMd();

// 1. 每 15 秒主动检查一次 OpenClaw 的后台进度，同步到 UI
setInterval(syncDbToMd, 15000);

// 2. 挂载 Watcher，人类在 Obsidian 秒打勾，秒推给 SQLite
chokidar.watch(MD_PATH, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
}).on('change', handleMdChange);
