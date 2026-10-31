// IAM from commit 3026801 is integrated into the shared FastAPI/PostgreSQL app.
// The original Node implementation is preserved in Git history and the review checkout.
console.error('Use .venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 3000. See IAM_INTEGRATION.md.');
process.exitCode = 1;
