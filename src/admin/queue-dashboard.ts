// src/admin/queue-dashboard.ts
import express from "express";
import { QueueManager } from "../queues/QueueManager";
import { connectDB } from "../connectDB";

const app = express();

app.use(express.json());
app.use(express.static('public'));

// Set up basic HTML template
const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Queue Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .card { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
        .stat-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; }
        .stat-number { font-size: 2em; font-weight: bold; margin: 10px 0; }
        .actions { margin: 20px 0; }
        button { padding: 10px 20px; margin: 5px; border: none; border-radius: 4px; cursor: pointer; }
        .btn-primary { background: #007bff; color: white; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-success { background: #28a745; color: white; }
        .btn-warning { background: #ffc107; color: black; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background-color: #f8f9fa; }
        .status-active { color: #28a745; font-weight: bold; }
        .status-failed { color: #dc3545; font-weight: bold; }
        .status-waiting { color: #ffc107; font-weight: bold; }
        .refresh-btn { position: fixed; top: 20px; right: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 Queue Management Dashboard</h1>
        
        <button class="btn-primary refresh-btn" onclick="location.reload()">🔄 Refresh</button>
        
        <div class="card">
            <h2>Queue Statistics</h2>
            <div id="stats-container">Loading...</div>
        </div>

        <div class="card">
            <h2>Queue Actions</h2>
            <div class="actions">
                <button class="btn-success" onclick="performAction('resume')">▶️ Resume All Queues</button>
                <button class="btn-warning" onclick="performAction('pause')">⏸️ Pause All Queues</button>
                <button class="btn-danger" onclick="performAction('clear-failed')">🗑️ Clear Failed Jobs</button>
                <button class="btn-primary" onclick="performAction('cleanup')">🧹 Cleanup Old Jobs</button>
            </div>
        </div>

        <div class="card">
            <h2>Recent Failed Jobs</h2>
            <div id="failed-jobs-container">Loading...</div>
        </div>
    </div>

    <script>
        async function loadStats() {
            try {
                const response = await fetch('/admin/api/stats');
                const data = await response.json();
                
                const statsHTML = \`
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div>Call Queue</div>
                            <div class="stat-number">\${data.callQueue.waiting}</div>
                            <div>Waiting</div>
                        </div>
                        <div class="stat-card">
                            <div>Active Calls</div>
                            <div class="stat-number">\${data.callQueue.active}</div>
                            <div>Processing</div>
                        </div>
                        <div class="stat-card">
                            <div>Completed</div>
                            <div class="stat-number">\${data.callQueue.completed}</div>
                            <div>Today</div>
                        </div>
                        <div class="stat-card">
                            <div>Failed</div>
                            <div class="stat-number">\${data.callQueue.failed}</div>
                            <div>Total</div>
                        </div>
                        <div class="stat-card">
                            <div>Email Queue</div>
                            <div class="stat-number">\${data.emailQueue.waiting}</div>
                            <div>Pending</div>
                        </div>
                        <div class="stat-card">
                            <div>Scheduler</div>
                            <div class="stat-number">\${data.schedulerQueue.waiting}</div>
                            <div>Scheduled</div>
                        </div>
                    </div>
                \`;
                
                document.getElementById('stats-container').innerHTML = statsHTML;
            } catch (error) {
                document.getElementById('stats-container').innerHTML = '<p>Error loading stats: ' + error.message + '</p>';
            }
        }

        async function loadFailedJobs() {
            try {
                const response = await fetch('/admin/api/failed-jobs');
                const jobs = await response.json();
                
                if (jobs.length === 0) {
                    document.getElementById('failed-jobs-container').innerHTML = '<p>No failed jobs found.</p>';
                    return;
                }

                const tableHTML = \`
                    <table>
                        <thead>
                            <tr>
                                <th>Job ID</th>
                                <th>Queue</th>
                                <th>Failed At</th>
                                <th>Error</th>
                                <th>Attempts</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${jobs.map(job => \`
                                <tr>
                                    <td>\${job.id}</td>
                                    <td>\${job.queue}</td>
                                    <td>\${new Date(job.failedAt).toLocaleString()}</td>
                                    <td title="\${job.error}">\${job.error.substring(0, 50)}...</td>
                                    <td>\${job.attempts}</td>
                                    <td>
                                        <button class="btn-primary" onclick="retryJob('\${job.id}', '\${job.queue}')">🔄 Retry</button>
                                        <button class="btn-danger" onclick="removeJob('\${job.id}', '\${job.queue}')">🗑️ Remove</button>
                                    </td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                \`;
                
                document.getElementById('failed-jobs-container').innerHTML = tableHTML;
            } catch (error) {
                document.getElementById('failed-jobs-container').innerHTML = '<p>Error loading failed jobs: ' + error.message + '</p>';
            }
        }

        async function performAction(action) {
            try {
                const response = await fetch(\`/admin/api/action/\${action}\`, { method: 'POST' });
                const result = await response.json();
                alert(result.message || 'Action completed');
                location.reload();
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        async function retryJob(jobId, queue) {
            try {
                const response = await fetch(\`/admin/api/retry/\${queue}/\${jobId}\`, { method: 'POST' });
                const result = await response.json();
                alert(result.message || 'Job queued for retry');
                location.reload();
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        async function removeJob(jobId, queue) {
            if (!confirm('Are you sure you want to remove this job?')) return;
            
            try {
                const response = await fetch(\`/admin/api/remove/\${queue}/\${jobId}\`, { method: 'DELETE' });
                const result = await response.json();
                alert(result.message || 'Job removed');
                location.reload();
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        // Load data when page loads
        loadStats();
        loadFailedJobs();
        
        // Auto-refresh every 30 seconds
        setInterval(() => {
            loadStats();
            loadFailedJobs();
        }, 30000);
    </script>
</body>
</html>`;

// Dashboard route
app.get('/admin/queues', (req, res) => {
  res.send(dashboardHTML);
});

// API routes for dashboard
app.get('/admin/api/stats', async (req, res) => {
  try {
    const queueManager = QueueManager.getInstance();
    const stats = await queueManager.getQueueStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/admin/api/failed-jobs', async (req, res) => {
  try {
    const queueManager = QueueManager.getInstance();
    
    const [callFailed, emailFailed] = await Promise.all([
      queueManager.callQueue.getFailed(0, 50),
      queueManager.emailQueue.getFailed(0, 50)
    ]);

    const failedJobs = [
      ...callFailed.map(job => ({
        id: job.id,
        queue: 'call',
        failedAt: job.processedOn,
        error: job.failedReason || 'Unknown error',
        attempts: job.attemptsMade,
        data: job.data
      })),
      ...emailFailed.map(job => ({
        id: job.id,
        queue: 'email', 
        failedAt: job.processedOn,
        error: job.failedReason || 'Unknown error',
        attempts: job.attemptsMade,
        data: job.data
      }))
    ];

    res.json(failedJobs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get failed jobs' });
  }
});

app.post('/admin/api/action/:action', async (req, res) => {
  try {
    const { action } = req.params;
    const queueManager = QueueManager.getInstance();

    switch (action) {
      case 'resume':
        await queueManager.resumeCallQueue();
        res.json({ message: 'All queues resumed' });
        break;
      case 'pause':
        await queueManager.pauseCallQueue();
        res.json({ message: 'All queues paused' });
        break;
      case 'clear-failed':
        await queueManager.callQueue.clean(0, 0, 'failed');
        await queueManager.emailQueue.clean(0, 0, 'failed');
        res.json({ message: 'Failed jobs cleared' });
        break;
      case 'cleanup':
        await queueManager.cleanupQueues();
        res.json({ message: 'Old jobs cleaned up' });
        break;
      default:
        res.status(400).json({ error: 'Unknown action' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Action failed: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

app.post('/admin/api/retry/:queue/:jobId', async (req, res) => {
  try {
    const { queue, jobId } = req.params;
    const queueManager = QueueManager.getInstance();

    let targetQueue;
    switch (queue) {
      case 'call':
        targetQueue = queueManager.callQueue;
        break;
      case 'email':
        targetQueue = queueManager.emailQueue;
        break;
      default:
        return res.status(400).json({ error: 'Unknown queue' });
    }

    const job = await targetQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    await job.retry();
    res.json({ message: 'Job queued for retry' });
  } catch (error) {
    res.status(500).json({ error: 'Retry failed: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

app.delete('/admin/api/remove/:queue/:jobId', async (req, res) => {
  try {
    const { queue, jobId } = req.params;
    const queueManager = QueueManager.getInstance();

    let targetQueue;
    switch (queue) {
      case 'call':
        targetQueue = queueManager.callQueue;
        break;
      case 'email':
        targetQueue = queueManager.emailQueue;
        break;
      default:
        return res.status(400).json({ error: 'Unknown queue' });
    }

    const job = await targetQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    await job.remove();
    res.json({ message: 'Job removed' });
  } catch (error) {
    res.status(500).json({ error: 'Remove failed: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

// Start dashboard server
async function startDashboard() {
  try {
    await connectDB();
    const queueManager = QueueManager.getInstance();
    console.log('✅ Queue dashboard initialized');

    const port = process.env.DASHBOARD_PORT || 3001;
    app.listen(port, () => {
      console.log(`📊 Queue Dashboard running on http://localhost:${port}/admin/queues`);
    });
  } catch (error) {
    console.error('❌ Failed to start dashboard:', error);
    process.exit(1);
  }
}

// Start if called directly
if (require.main === module) {
  startDashboard();
}

export default app;