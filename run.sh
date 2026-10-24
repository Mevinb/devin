#!/usr/bin/env bash

# ==============================================================================
# PixelSentinel Startup Script
# Visual QA & Multi-Device Testing Platform
# ==============================================================================

set -eo pipefail

# ANSI color codes
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Determine project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# Default configuration
DEFAULT_PORT=3000
PORT="${PORT:-$DEFAULT_PORT}"
DEV_MODE=false
FORCE_BUILD=false

# Print script usage instructions
print_help() {
  echo -e "${BOLD}PixelSentinel Startup Script${NC}"
  echo -e ""
  echo -e "${BOLD}USAGE:${NC}"
  echo -e "  ./run.sh [OPTIONS]"
  echo -e ""
  echo -e "${BOLD}OPTIONS:${NC}"
  echo -e "  -p, --port <number>    Specify the port for the web dashboard (default: 3000 or \$PORT)"
  echo -e "  -d, --dev              Run in development mode (hot-reloading server & Vite client)"
  echo -e "  -b, --build            Force rebuild all packages before starting"
  echo -e "  -h, --help             Show this help message and exit"
  echo -e ""
  echo -e "${BOLD}EXAMPLES:${NC}"
  echo -e "  ./run.sh               # Start production dashboard at http://localhost:3000"
  echo -e "  ./run.sh --port 8080   # Start on port 8080"
  echo -e "  ./run.sh --dev         # Start in development mode with live watch"
  echo -e "  ./run.sh --build       # Force rebuild workspace assets before starting"
}

# Parse command line flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      PORT="$2"
      shift 2
      ;;
    -d|--dev)
      DEV_MODE=true
      shift
      ;;
    -b|--build)
      FORCE_BUILD=true
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      print_help
      exit 1
      ;;
  esac
done

echo -e "\n${BOLD}${CYAN}─────────────────────────────────────────────────────────────${NC}"
echo -e "${BOLD}${CYAN}   👁️  PixelSentinel - Visual QA & Multi-Device Platform${NC}"
echo -e "${BOLD}${CYAN}─────────────────────────────────────────────────────────────${NC}\n"

# 1. Prerequisite Checks
echo -e "${DIM}Checking system environment...${NC}"

if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Error: Node.js is not installed or not in PATH.${NC}"
  echo "Please install Node.js (version 18 or newer) to run PixelSentinel."
  exit 1
fi

NODE_MAJOR=$(node -v | cut -d'.' -f1 | sed 's/v//')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${RED}Error: Node.js version $(node -v) is too old.${NC}"
  echo "PixelSentinel requires Node.js v18 or newer."
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo -e "${RED}Error: pnpm is not installed or not in PATH.${NC}"
  echo "Please install pnpm (e.g., 'npm install -g pnpm')."
  exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v) & pnpm detected.${NC}"

# 2. Load Environment Variables
if [ -f ".env" ]; then
  echo -e "${GREEN}✓ Loaded configuration from .env${NC}"
else
  echo -e "${YELLOW}! No .env file found. Proceeding with system defaults.${NC}"
fi

# 3. Check / Run Build
SERVER_DIST="packages/server/dist/index.js"
WEB_DIST="packages/web/dist/index.html"

NEEDS_BUILD=false
if [ "$FORCE_BUILD" = true ]; then
  NEEDS_BUILD=true
elif [ ! -f "$SERVER_DIST" ] || [ ! -f "$WEB_DIST" ]; then
  NEEDS_BUILD=true
fi

if [ "$NEEDS_BUILD" = true ]; then
  echo -e "\n${CYAN}Building project packages and web bundle...${NC}"
  pnpm build
  echo -e "${GREEN}✓ Build completed successfully.${NC}"
fi

# 4. Check Port Availability
if command -v lsof >/dev/null 2>&1; then
  OCCUPYING_PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$OCCUPYING_PID" ]; then
    echo -e "${YELLOW}Warning: Port $PORT is already in use by process PID $OCCUPYING_PID.${NC}"
    echo -e "Attempting to release port $PORT..."
    kill "$OCCUPYING_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# 5. Launch Services
export PORT="$PORT"

if [ "$DEV_MODE" = true ]; then
  echo -e "\n${BOLD}${GREEN}Starting PixelSentinel in DEVELOPMENT mode...${NC}"
  echo -e "${DIM}• Fastify Backend: http://localhost:${PORT}${NC}"
  echo -e "${DIM}• Vite Frontend:   http://localhost:5173${NC}\n"

  # Trap cleanup on exit
  cleanup() {
    echo -e "\n${YELLOW}Shutting down dev processes...${NC}"
    kill $(jobs -p) 2>/dev/null || true
  }
  trap cleanup SIGINT SIGTERM EXIT

  # Start backend & web dev servers
  pnpm --filter @pixelsentinel/server dev &
  pnpm --filter @pixelsentinel/web dev &
  wait
else
  echo -e "\n${BOLD}${GREEN}Starting PixelSentinel Production Dashboard...${NC}"
  echo -e "${CYAN}Access the web dashboard at: ${BOLD}http://localhost:${PORT}${NC}\n"

  NODE_ENV_FLAG=""
  if [ -f ".env" ]; then
    NODE_ENV_FLAG="--env-file=.env"
  fi

  exec node $NODE_ENV_FLAG packages/server/dist/index.js
fi
