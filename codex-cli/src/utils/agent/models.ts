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

// Define global telemetry type
declare global {
  var twoAgentTelemetry: Array<{
    ts: number;
    role: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    duration_ms: number;
  }>;
}

// Initialize global telemetry array if it doesn't exist
if (typeof global.twoAgentTelemetry === 'undefined') {
  global.twoAgentTelemetry = [];
}

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
      // Track start time for telemetry
      const startTime = Date.now();
      
      const response = await oai.chat.completions.create({
        model: architectModel,
        messages: [
          { role: "system", content: architectPrompt },
          { role: "user", content: JSON.stringify(input) }
        ],
        response_format: { type: "json_object" }
      });
      
      // Calculate telemetry data
      const tokensIn = response.usage?.prompt_tokens || input.toString().length / 4; // rough estimate if not provided
      const tokensOut = response.usage?.completion_tokens || response.choices[0]?.message?.content?.length / 4;
      const costUsd = calculateCost(architectModel, tokensIn, tokensOut);
      
      // Log telemetry
      log(`Architect model call: ${tokensIn} tokens in, ${tokensOut} tokens out, $${costUsd.toFixed(6)} cost`);
      
      // Record telemetry in global event
      if (global.twoAgentTelemetry) {
        global.twoAgentTelemetry.push({
          ts: Date.now(),
          role: 'architect',
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: costUsd,
          duration_ms: Date.now() - startTime
        });
      }
      
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
 * Calculate approximate cost based on model and token counts
 * Based on approximate pricing as of 2025
 */
function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  // Default to higher tier costs if model can't be identified
  let promptPrice = 0.0015; // per 1K tokens
  let completionPrice = 0.0020; // per 1K tokens
  
  const modelLower = model.toLowerCase();
  
  // O3 family (equivalent to gpt-4 family)
  if (modelLower.includes('o3') || modelLower.includes('gpt-4')) {
    promptPrice = 0.0015;
    completionPrice = 0.0020;
  }
  // O4-mini family (equivalent to gpt-4o-mini)
  else if (modelLower.includes('o4-mini') || modelLower.includes('gpt-4o-mini')) {
    promptPrice = 0.0003;
    completionPrice = 0.0006;
  }
  // GPT-3.5 family
  else if (modelLower.includes('gpt-3.5')) {
    promptPrice = 0.0001;
    completionPrice = 0.0002;
  }
  
  // Calculate cost in USD
  return (promptTokens / 1000) * promptPrice + (completionTokens / 1000) * completionPrice;
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
      // Track start time for telemetry
      const startTime = Date.now();
      
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
      
      // Calculate telemetry data
      const inputSize = coderPrompt.length + JSON.stringify({action, fileContent}).length;
      const tokensIn = response.usage?.prompt_tokens || inputSize / 4; // rough estimate if not provided
      const tokensOut = response.usage?.completion_tokens || response.choices[0]?.message?.content?.length / 4;
      const costUsd = calculateCost(coderModel, tokensIn, tokensOut);
      
      // Log telemetry
      log(`Coder model call: ${tokensIn} tokens in, ${tokensOut} tokens out, $${costUsd.toFixed(6)} cost`);
      
      // Record telemetry in global event
      if (global.twoAgentTelemetry) {
        global.twoAgentTelemetry.push({
          ts: Date.now(),
          role: 'coder',
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: costUsd,
          duration_ms: Date.now() - startTime
        });
      }
      
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