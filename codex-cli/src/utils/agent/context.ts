import type { EditAction } from "./change_plan.js";
import type { AppConfig } from "../config.js";

import { log, isLoggingEnabled } from "./log.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const CACHE_DIR = path.join(process.env.HOME || "~", ".codex/cache");

/**
 * Ensures the cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Generates a summary for a file and caches it
 * @param filePath Path to the file
 * @param config App configuration
 * @returns A brief summary of the file
 */
export async function getOrCreateFileSummary(filePath: string, config: AppConfig): Promise<string> {
  ensureCacheDir();
  
  const fileHash = getFileHash(filePath);
  const summaryPath = path.join(CACHE_DIR, `${fileHash}.summary`);
  
  // Check if summary exists and is up-to-date
  if (fs.existsSync(summaryPath)) {
    try {
      return fs.readFileSync(summaryPath, "utf-8");
    } catch (error) {
      log(`Error reading summary from cache: ${error}`);
      // Fall through to regenerate
    }
  }
  
  // Need to generate a new summary
  const summary = await generateFileSummary(filePath, config);
  
  // Cache the summary
  try {
    fs.writeFileSync(summaryPath, summary, "utf-8");
  } catch (error) {
    log(`Error writing summary to cache: ${error}`);
  }
  
  return summary;
}

/**
 * Creates a hash of the file content for caching
 */
function getFileHash(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // Simple hash for caching - production would use proper hash function
    return Buffer.from(filePath + content.length).toString("base64").replace(/[/+=]/g, "_");
  } catch (error) {
    log(`Error hashing file ${filePath}: ${error}`);
    return Buffer.from(filePath).toString("base64").replace(/[/+=]/g, "_");
  }
}

/**
 * Generates a summary for a file
 * @param filePath Path to the file
 * @param config App configuration
 * @returns A brief summary of the file
 */
async function generateFileSummary(filePath: string, config: AppConfig): Promise<string> {
  try {
    // For now, a minimal summary based on file size and extension
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath);
    
    // Get repo path for relative file path
    let repoPath = "";
    try {
      repoPath = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    } catch {
      repoPath = process.cwd();
    }
    
    const relativePath = path.relative(repoPath, filePath);
    
    return `${relativePath} (${ext} file, ${stats.size} bytes, last modified ${stats.mtime.toISOString()})`;
  } catch (error) {
    log(`Error generating summary for ${filePath}: ${error}`);
    return `${filePath} (unable to summarize)`;
  }
}

/**
 * Builds context for the Coder agent based on an edit action
 * @param action The edit action
 * @param config App configuration
 * @returns Context object with file content and relevant summaries
 */
export async function buildCoderContext(action: EditAction, config: AppConfig): Promise<{ 
  fileContent: string;
  fileSummary: string;
  repoOverview: string;
}> {
  // Read the target file content
  let fileContent = "";
  try {
    fileContent = fs.readFileSync(action.file, "utf-8");
  } catch (error) {
    log(`Error reading file ${action.file}: ${error}`);
    fileContent = ""; // File might be new
  }
  
  // Get file summary
  const fileSummary = await getOrCreateFileSummary(action.file, config);
  
  // Generate simple repo overview
  const repoOverview = getRepoOverview();
  
  return {
    fileContent,
    fileSummary,
    repoOverview,
  };
}

/**
 * Gets a basic overview of the repository
 */
function getRepoOverview(): string {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    const gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    const fileCount = execSync("git ls-files | wc -l", { encoding: "utf-8" }).trim();
    
    return `Repository at ${gitRoot}, branch: ${gitBranch}, files: ${fileCount}`;
  } catch (error) {
    log(`Error getting repo overview: ${error}`);
    return "No repository information available";
  }
}