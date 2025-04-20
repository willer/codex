import type { AppConfig } from "./utils/config";
import { MultiAgentOrchestrator } from "./utils/agent/multi-agent";
import { AgentRole } from "./utils/agent/multi-agent";
import { log, isLoggingEnabled } from "./utils/agent/log.js";
import { checkInGit } from "./utils/check-in-git";
import { render, Box, Text } from "ink";
import React, { useState } from "react";
import { execSync } from "child_process";
import path from "path";

/**
 * Simple UI component for the multi-agent mode
 */
const MultiAgentApp = ({
  originalPrompt,
  config,
  rootPath,
  onExit,
}: {
  originalPrompt?: string;
  config: AppConfig;
  rootPath: string;
  onExit: () => void;
}) => {
  const [output, setOutput] = useState<string>("");
  const [currentAgent, setCurrentAgent] = useState<string>("orchestrator");
  const [status, setStatus] = useState<string>("initializing");
  const [step, setStep] = useState<string>("0/0");

  React.useEffect(() => {
    const runMultiAgent = async () => {
      if (!originalPrompt) {
        setOutput("No prompt provided. Please provide a prompt.");
        onExit();
        return;
      }

      try {
        setStatus("initializing");
        
        // Get repository context
        const repoContext = {
          rootPath,
          fileStructure: getFileStructure(rootPath),
          gitInfo: getGitInfo(rootPath)
        };

        // Initialize orchestrator
        const orchestrator = new MultiAgentOrchestrator({
          config,
          onResponse: (response) => {
            setOutput(response);
          },
          onStateChange: (state) => {
            setStatus(state.status);
            setStep(`${state.currentStep}/${state.totalSteps}`);
          },
          onStepCompleted: (role, output) => {
            setCurrentAgent(role);
            if (isLoggingEnabled()) {
              log(`[MultiAgentApp] Agent ${role} completed step`);
            }
          }
        });
        
        // Initialize the agents
        orchestrator.initialize();
        
        // Set repository context
        orchestrator.setRepoContext(repoContext);
        
        // Execute the request
        await orchestrator.executeRequest(originalPrompt);
        
        // Signal completion
        setStatus("completed");
        onExit();
      } catch (error) {
        setStatus("failed");
        setOutput(`Error: ${error instanceof Error ? error.message : String(error)}`);
        onExit();
      }
    };

    runMultiAgent();
  }, [originalPrompt, config, rootPath, onExit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Codex Multi-Agent Mode</Text>
      </Box>
      
      <Box marginBottom={1}>
        <Text>Prompt: </Text>
        <Text color="green">{originalPrompt}</Text>
      </Box>
      
      <Box marginBottom={1}>
        <Text>Status: </Text>
        <Text color={status === "completed" ? "green" : status === "failed" ? "red" : "yellow"}>
          {status}
        </Text>
        <Text> | Current agent: </Text>
        <Text color="cyan">{currentAgent}</Text>
        <Text> | Step: </Text>
        <Text color="yellow">{step}</Text>
      </Box>
      
      {output && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Result:</Text>
          <Box padding={1} borderStyle="single">
            <Text>{output}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

/**
 * Get file structure for the repository
 */
function getFileStructure(rootPath: string): string[] {
  try {
    // Use git ls-files to get tracked files
    const gitFiles = execSync('git ls-files', { cwd: rootPath }).toString().trim().split('\n');
    
    // Filter out common binary files and limit to a reasonable number
    return gitFiles
      .filter(file => !file.match(/\.(png|jpg|jpeg|gif|ico|ttf|woff|woff2|eot|mp3|mp4|mov|zip|tar\.gz)$/i))
      .filter(file => !file.includes('node_modules/'))
      .filter(file => !file.includes('.git/'))
      .slice(0, 200); // Limit to avoid context overflow
  } catch (error) {
    // Fallback if git ls-files fails
    return ["Failed to get file structure"];
  }
}

/**
 * Get git information for the repository
 */
function getGitInfo(rootPath: string): any {
  try {
    const isRepo = checkInGit(rootPath);
    if (!isRepo) {
      return {
        currentBranch: "",
        isClean: false
      };
    }
    
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: rootPath }).toString().trim();
    
    // Check if repo is clean
    const status = execSync('git status --porcelain', { cwd: rootPath }).toString().trim();
    const isClean = status === "";
    
    // Get last commit info
    const lastCommitHash = execSync('git rev-parse HEAD', { cwd: rootPath }).toString().trim();
    const lastCommitMessage = execSync('git log -1 --pretty=%B', { cwd: rootPath }).toString().trim();
    const lastCommitAuthor = execSync('git log -1 --pretty=%an', { cwd: rootPath }).toString().trim();
    const lastCommitDate = execSync('git log -1 --pretty=%ad', { cwd: rootPath }).toString().trim();
    
    return {
      currentBranch,
      isClean,
      lastCommit: {
        hash: lastCommitHash,
        message: lastCommitMessage,
        author: lastCommitAuthor,
        date: lastCommitDate
      }
    };
  } catch (error) {
    return {
      currentBranch: "",
      isClean: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Main function to run the multi-agent mode
 */
export async function runMultiAgent({
  originalPrompt,
  config,
  rootPath,
}: {
  originalPrompt?: string;
  config: AppConfig;
  rootPath: string;
}): Promise<void> {
  return new Promise((resolve) => {
    render(
      <MultiAgentApp
        originalPrompt={originalPrompt}
        config={config}
        rootPath={rootPath}
        onExit={() => resolve()}
      />,
    );
  });
}

export default {};