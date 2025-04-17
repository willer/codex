import type { AppConfig } from "../config.js";
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";
import type { Reasoning } from "openai/resources.mjs";

import { log, isLoggingEnabled } from "./log.js";
import { OPENAI_BASE_URL, OPENAI_TIMEOUT_MS } from "../config.js";
import {
  ORIGIN,
  CLI_VERSION,
  getSessionId,
} from "../session.js";
import fs from "fs";
import path from "path";
import OpenAI, { APIConnectionTimeoutError } from "openai";

const MAX_RETRIES = 5;
const RATE_LIMIT_RETRY_WAIT_MS = parseInt(
  process.env["OPENAI_RATE_LIMIT_RETRY_WAIT_MS"] || "2500",
  10,
);

/**
 * Initializes an OpenAI client with appropriate configuration
 */
function createOpenAIClient(config: AppConfig): OpenAI {
  const timeoutMs = OPENAI_TIMEOUT_MS;
  const apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
  
  return new OpenAI({
    ...(apiKey ? { apiKey } : {}),
    baseURL: OPENAI_BASE_URL,
    defaultHeaders: {
      originator: ORIGIN,
      version: CLI_VERSION,
      session_id: getSessionId() || "",
    },
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
}

/**
 * Loads a prompt from the prompts directory
 */
function loadPrompt(promptName: string): string {
  try {
    const promptPath = path.join(process.cwd(), "prompts", promptName);
    return fs.readFileSync(promptPath, "utf-8");
  } catch (error) {
    log(`Error loading prompt ${promptName}: ${error}`);
    return "";
  }
}

/**
 * Calls the Architect model to generate a Change Plan
 */
export async function callArchitect(
  input: Array<ResponseInputItem>,
  config: AppConfig,
  previousResponseId?: string,
): Promise<string> {
  const oai = createOpenAIClient(config);
  const architectModel = config.architectModel || config.model;
  const architectPrompt = loadPrompt("architect.md");
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await oai.chat.completions.create({
        model: architectModel,
        messages: [
          { role: "system", content: architectPrompt },
          { role: "user", content: JSON.stringify(input) }
        ],
        response_format: { type: "json_object" }
      });
      
      return response.choices[0]?.message?.content || "";
    } catch (error) {
      if (await shouldRetry(error, attempt)) {
        continue;
      }
      throw error;
    }
  }
  
  throw new Error("Failed to get response from Architect model after maximum retries");
}

/**
 * Calls the Coder model to implement a single file edit
 */
export async function callCoder(
  action: unknown,
  fileContent: string,
  config: AppConfig,
): Promise<string> {
  const oai = createOpenAIClient(config);
  const coderModel = config.coderModel || "gpt-3.5-turbo-0125";
  const coderPrompt = loadPrompt("coder.md");
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await oai.chat.completions.create({
        model: coderModel,
        temperature: config.coderTemp || 0.2,
        messages: [
          { role: "system", content: coderPrompt },
          { 
            role: "user", 
            content: JSON.stringify({
              action,
              fileContent
            })
          }
        ]
      });
      
      return response.choices[0]?.message?.content || "";
    } catch (error) {
      if (await shouldRetry(error, attempt)) {
        continue;
      }
      throw error;
    }
  }
  
  throw new Error("Failed to get response from Coder model after maximum retries");
}

/**
 * Determines if a request should be retried based on the error
 */
async function shouldRetry(error: unknown, attempt: number): Promise<boolean> {
  if (attempt >= MAX_RETRIES) {
    return false;
  }
  
  if (error instanceof APIConnectionTimeoutError) {
    log(`OpenAI request timeout (attempt ${attempt}/${MAX_RETRIES}), retrying...`);
    return true;
  }
  
  // Lazily look up the APIConnectionError class at runtime
  const ApiConnErrCtor = (OpenAI as any).APIConnectionError as
    | (new (...args: any) => Error)
    | undefined;
  
  const isConnectionError = ApiConnErrCtor
    ? error instanceof ApiConnErrCtor
    : false;
  
  // Check for rate limit errors
  const errCtx = error as any;
  const status = errCtx?.status ?? errCtx?.httpStatus ?? errCtx?.statusCode;
  const isServerError = typeof status === "number" && status >= 500;
  
  if (isConnectionError || isServerError) {
    log(`OpenAI connection error (attempt ${attempt}/${MAX_RETRIES}), retrying...`);
    return true;
  }
  
  const isRateLimit =
    status === 429 ||
    errCtx.code === "rate_limit_exceeded" ||
    errCtx.type === "rate_limit_exceeded" ||
    /rate limit/i.test(errCtx.message ?? "");
  
  if (isRateLimit) {
    // Exponential backoff
    let delayMs = RATE_LIMIT_RETRY_WAIT_MS * 2 ** (attempt - 1);
    
    // Parse suggested retry time from error message
    const msg = errCtx?.message ?? "";
    const m = /retry again in ([\d.]+)s/i.exec(msg);
    if (m && m[1]) {
      const suggested = parseFloat(m[1]) * 1000;
      if (!Number.isNaN(suggested)) {
        delayMs = suggested;
      }
    }
    
    log(`OpenAI rate limit exceeded (attempt ${attempt}/${MAX_RETRIES}), retrying in ${Math.round(delayMs)} ms...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return true;
  }
  
  return false;
}