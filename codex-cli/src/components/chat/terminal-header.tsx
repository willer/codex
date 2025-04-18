import type { AgentLoop } from "../../utils/agent/agent-loop.js";
import type { AppConfig } from "../../utils/config.js";

import { Box, Text } from "ink";
import path from "node:path";
import React from "react";

export interface TerminalHeaderProps {
  terminalRows: number;
  version: string;
  PWD: string;
  model: string;
  approvalPolicy: string;
  colorsByPolicy: Record<string, string | undefined>;
  agent?: AgentLoop;
  initialImagePaths?: Array<string>;
  config?: AppConfig;
}

const TerminalHeader: React.FC<TerminalHeaderProps> = ({
  terminalRows,
  version,
  PWD,
  model,
  approvalPolicy,
  colorsByPolicy,
  agent,
  initialImagePaths,
  config,
}) => {
  return (
    <>
      {terminalRows < 10 ? (
        // Compact header for small terminal windows
        <Text>
          ● Codex v{version} – {PWD} – {config?.twoAgent ? `${config.architectModel || model}+${config.coderModel || "gpt-3.5"}` : model} –{" "}
          <Text color={colorsByPolicy[approvalPolicy]}>{approvalPolicy}</Text>
        </Text>
      ) : (
        <>
          <Box borderStyle="round" paddingX={1} width={64}>
            <Text>
              ● OpenAI <Text bold>Codex</Text>{" "}
              <Text dimColor>
                (research preview) <Text color="blueBright">v{version}</Text>
              </Text>
            </Text>
          </Box>
          <Box
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
            width={64}
            flexDirection="column"
          >
            <Text>
              localhost <Text dimColor>session:</Text>{" "}
              <Text color="magentaBright" dimColor>
                {agent?.sessionId ?? "<no-session>"}
              </Text>
            </Text>
            <Text dimColor>
              <Text color="blueBright">↳</Text> workdir: <Text bold>{PWD}</Text>
            </Text>
            {config?.twoAgent ? (
              <Text dimColor>
                <Text color="blueBright">↳</Text> model: <Text bold>{config.architectModel || model} + {config.coderModel || "gpt-3.5-turbo"}</Text>
                <Text dimColor> (two-agent)</Text>
              </Text>
            ) : (
              <Text dimColor>
                <Text color="blueBright">↳</Text> model: <Text bold>{model}</Text>
              </Text>
            )}
            <Text dimColor>
              <Text color="blueBright">↳</Text> approval:{" "}
              <Text bold color={colorsByPolicy[approvalPolicy]} dimColor>
                {approvalPolicy}
              </Text>
            </Text>
            {initialImagePaths?.map((img, idx) => (
              <Text key={img ?? idx} color="gray">
                <Text color="blueBright">↳</Text> image:{" "}
                <Text bold>{path.basename(img)}</Text>
              </Text>
            ))}
          </Box>
        </>
      )}
    </>
  );
};

export default TerminalHeader;
