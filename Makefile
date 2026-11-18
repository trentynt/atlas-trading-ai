# ATLAS — reproducible startup commands (GitHub Codespaces / any Linux with Python 3.12+ and Node 20+)
.PHONY: setup backend frontend dev test build clean

VENV := .venv
PY   := $(VENV)/bin/python

setup:            ## install backend + frontend dependencies
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r backend/requirements.txt
	cd frontend && npm install

backend:          ## run the FastAPI backend on :8000 (fetches market data on first start)
	cd backend && ../$(PY) -m uvicorn atlas.main:app --host 127.0.0.1 --port 8000 --reload

frontend:         ## run the Vite dev server on :5173 (proxies /api to :8000)
	cd frontend && npm run dev

dev:              ## run both in one terminal
	$(MAKE) -j2 backend frontend

test:             ## backend test-suite (offline; providers are faked)
	cd backend && ../$(PY) -m pytest -q

build:            ## type-check, lint and production-build the frontend
	cd frontend && npx tsc -b && npx oxlint src && npm run build

clean:            ## remove runtime data (market cache, experiments, paper ledger)
	rm -rf data/
