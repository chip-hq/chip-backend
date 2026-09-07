/**
 * Chip — AI Circuit Agent
 * All-in-one AI agent powered by Featherless (OpenAI-compatible) API.
 * Automates hardware circuit diagram creation, component placement, and pin wiring.
 */

import { getDb, isDbConnected } from '../services/storage.js';

const FEATHERLESS_BASE_URL = 'https://api.featherless.ai/v1';

export const SUPPORTED_MODELS = [
  { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2 (Reasoning & Code)', units: 4 },
  { id: 'mistralai/Mistral-Nemo-Instruct-2407', name: 'Mistral Nemo (Lightweight & Fast)', units: 1 },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5 (Tool Use & Agent)', units: 4 },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5 (Long Context)', units: 4 },
];

function getApiKey() {
  return (
    process.env.FEATHERLESS_API_KEY ||
    process.env.AI_AGENT_APIKEY ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();
}

/**
 * Tool definitions in OpenAI format
 */
const CIRCUIT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'add_component',
      description: 'Add a new electronic component to the circuit diagram',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Reference designator (e.g. U1, R1, D1, SW1, C1)' },
          part: { type: 'string', description: 'Component part name (e.g. ESP32-WROOM-32, R, LED, SW_Push)' },
          lib: { type: 'string', description: 'KiCad library name (e.g. MCU_Espressif, Device, Switch)' },
          value: { type: 'string', description: 'Component value or label (e.g. 220, 10k, Red, 3.3V)' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_pins',
      description: 'Connect two or more component pins together with a named net/wire',
      parameters: {
        type: 'object',
        properties: {
          net: { type: 'string', description: 'Descriptive net name (e.g. LED_SIG, GND, 3V3, BTN_IN, I2C_SDA)' },
          nodes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Component pin nodes in Ref.Pin format (e.g. ["U1.IO2", "R1.1"] or ["R1.2", "D1.A"])',
          },
        },
        required: ['net', 'nodes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_component',
      description: 'Remove a component and its associated pin connections from the circuit',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Component reference to remove (e.g. R1, D1)' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_component',
      description: 'Update the value or label of an existing component',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Component reference (e.g. R1)' },
          value: { type: 'string', description: 'New value (e.g. 330, 4.7k)' },
          name: { type: 'string', description: 'Optional new display name' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'disconnect_pins',
      description: 'Disconnect a pin node or remove an entire net',
      parameters: {
        type: 'object',
        properties: {
          net: { type: 'string', description: 'Net name to remove (optional)' },
          node: { type: 'string', description: 'Specific pin node to remove (e.g. "R1.1")' },
        },
      },
    },
  },
];

const SYSTEM_PROMPT = `You are Chip's expert Hardware Circuit Design AI Agent.
You help engineers and makers design, wire, and modify ESP32 microcontrollers and embedded electronic circuits.
You have direct tools to modify the circuit diagram in real time.

INTENT DETECTION — Read the user's request carefully before deciding what to do:
- If the user says "add", "place", "put", "include", "insert" a component → ONLY call add_component. Do NOT wire anything unless explicitly asked.
- If the user says "wire", "connect", "build the circuit", "connect the pins", "hook up" → call add_component AND connect_pins as needed.
- If the user says "build" or "create a circuit for [function]" with a specific use case (e.g. "build LED circuit") → add AND wire the complete circuit.
- Never assume wiring is wanted just because a component was added. Ask the user if they want wiring after adding.

COMPONENT KNOWLEDGE — Use exact part names and libs:
- ESP32 MCU: ref "U1", lib "RF_Module", part "ESP32-WROOM-32", pins use GPIO names: IO0, IO2, IO4, IO12, IO13, IO14, IO18, IO19, IO21(SDA), IO22(SCL), IO23, IO25, IO26, IO27, IO32, IO33, GND, 3V3.
- Resistors: ref "R1","R2"..., lib "Device", part "R", value "220" or "10k", pins: "1" (in) and "2" (out).
- LEDs: ref "D1","D2"..., lib "Device", part "LED", pins: "A" (Anode, +) and "K" (Cathode, -).
- Pushbuttons: ref "SW1","SW2"..., lib "Switch", part "SW_Push", pins: "1" and "2".
- Capacitors: ref "C1","C2"..., lib "Device", part "C", value "100nF" or "10uF", pins: "1" (+) and "2" (-).
- SSD1306 OLED (0.96" I2C 128x64): ref "DS1", lib "Display_Graphic", part "SSD1306_128x64", pins: "VCC", "GND", "SCL", "SDA".
- GME12864 / SH1106 OLED (1.3" I2C 128x64): ref "DS1", lib "Display_Graphic", part "GME12864", value "GME12864", pins: "VCC", "GND", "SCL", "SDA". NOTE: This uses the SH110X driver, NOT SSD1306.
- NPN Transistor: ref "Q1", lib "Device", part "2N2222", pins: "B" (Base), "C" (Collector), "E" (Emitter).

WIRING RULES (only apply when user explicitly wants wiring):
- Format pin nodes strictly as "Ref.Pin" (e.g. "U1.IO2", "R1.1", "D1.A", "DS1.SDA").
- I2C devices (OLED etc.): Connect DS1.SDA → U1.IO21 (net "I2C_SDA"), DS1.SCL → U1.IO22 (net "I2C_SCL"), DS1.VCC → U1.3V3 (net "3V3"), DS1.GND → U1.GND (net "GND").
- LED output: U1.GPIO → R1.1 (net "LED_SIG"), R1.2 → D1.A (net "LED_A"), D1.K → U1.GND (net "GND").
- Pushbutton: U1.GPIO → SW1.1 (net "BTN_SIG"), SW1.2 → U1.GND (net "GND"), add 10kΩ pull-up R from 3V3 → SW1.1.
- Keep net names UPPERCASE and descriptive: "GND", "3V3", "I2C_SDA", "I2C_SCL", "LED_SIG", "BTN_SIG".

Be clear and concise in your replies. Always tell the user what you added or connected, and offer next steps.`;

/**
 * Loads current circuit definition from MongoDB
 */
async function getProjectCircuit(projectId, userId) {
  if (!isDbConnected()) {
    return {
      version: 0,
      circuitName: `${projectId} Circuit`,
      projectId,
      components: [],
      connections: [],
    };
  }

  const db = getDb();
  const doc = await db.collection('circuit_versions')
    .findOne({ projectId, userId, isCurrent: true })
    .catch(() => null);

  if (doc?.definition) {
    return {
      version: doc.version || 1,
      ...doc.definition,
    };
  }

  return {
    version: 0,
    circuitName: `${projectId} Circuit`,
    projectId,
    components: [],
    connections: [],
  };
}

/**
 * Saves modified circuit version to MongoDB
 */
async function saveProjectCircuit(projectId, userId, definition, actionDescriptions) {
  const nextVersion = (definition.version || 0) + 1;
  definition.version = nextVersion;

  const now = new Date().toISOString();
  const versionDoc = {
    projectId,
    userId,
    version: nextVersion,
    isCurrent: true,
    generatedAt: now,
    definition: {
      ...definition,
      version: nextVersion,
    },
    artifacts: {},
    meta: {
      componentCount: definition.components?.length ?? 0,
      connectionCount: definition.connections?.length ?? 0,
      ercErrorCount: 0,
      ercWarningCount: 0,
      lastAction: actionDescriptions.join(', '),
    },
  };

  if (isDbConnected()) {
    const db = getDb();
    await db.collection('circuit_versions')
      .updateMany({ projectId, userId }, { $set: { isCurrent: false } })
      .catch(() => {});

    await db.collection('circuit_versions').replaceOne(
      { projectId, userId, version: nextVersion },
      versionDoc,
      { upsert: true }
    );

    await db.collection('projects').updateOne(
      { id: projectId },
      { $set: { updatedAt: now } }
    ).catch(() => {});
  }

  return nextVersion;
}

/**
 * Executes a single tool call on the circuit definition
 */
function applyCircuitTool(definition, toolName, args) {
  definition.components = definition.components || [];
  definition.connections = definition.connections || [];

  if (toolName === 'add_component') {
    const ref = String(args.ref || '').trim();
    if (!ref) return null;

    const existingIdx = definition.components.findIndex(
      (c) => c.ref.toUpperCase() === ref.toUpperCase()
    );

    const comp = {
      ref,
      name: String(args.name || args.part || args.lib || ref).trim(),
      lib: String(args.lib || 'Device').trim(),
      value: String(args.value || args.part || ref).trim(),
    };

    if (existingIdx >= 0) {
      definition.components[existingIdx] = comp;
      return `Updated component ${ref} (${comp.value})`;
    } else {
      definition.components.push(comp);
      return `Added component ${ref} (${comp.value})`;
    }
  }

  if (toolName === 'connect_pins') {
    const net = String(args.net || '').trim().toUpperCase();
    const nodes = (args.nodes || []).map((n) => String(n).trim()).filter(Boolean);
    if (!net || nodes.length < 2) return null;

    const existingConn = definition.connections.find(
      (c) => (c.net || '').toUpperCase() === net
    );

    if (existingConn) {
      const merged = Array.from(new Set([...(existingConn.nodes || []), ...nodes]));
      existingConn.nodes = merged;
      return `Connected to net ${net}: ${nodes.join(', ')}`;
    } else {
      definition.connections.push({ net, nodes });
      return `Created net ${net} connecting ${nodes.join(' ↔ ')}`;
    }
  }

  if (toolName === 'remove_component') {
    const ref = String(args.ref || '').trim().toUpperCase();
    if (!ref) return null;

    const before = definition.components.length;
    definition.components = definition.components.filter(
      (c) => c.ref.toUpperCase() !== ref
    );

    if (definition.components.length === before) return null;

    // Remove connected pin nodes
    definition.connections = definition.connections
      .map((conn) => ({
        ...conn,
        nodes: (conn.nodes || []).filter((n) => !n.toUpperCase().startsWith(`${ref}.`)),
      }))
      .filter((conn) => (conn.nodes || []).length > 0);

    return `Removed component ${ref}`;
  }

  if (toolName === 'update_component') {
    const ref = String(args.ref || '').trim().toUpperCase();
    const comp = definition.components.find((c) => c.ref.toUpperCase() === ref);
    if (!comp) return null;

    if (args.value) comp.value = String(args.value).trim();
    if (args.name) comp.name = String(args.name).trim();
    return `Updated ${ref} value to ${comp.value}`;
  }

  if (toolName === 'disconnect_pins') {
    const net = args.net ? String(args.net).trim().toUpperCase() : null;
    const node = args.node ? String(args.node).trim().toUpperCase() : null;

    if (net && !node) {
      definition.connections = definition.connections.filter(
        (c) => (c.net || '').toUpperCase() !== net
      );
      return `Removed net ${net}`;
    }

    if (node) {
      definition.connections = definition.connections
        .map((conn) => {
          if (!net || (conn.net || '').toUpperCase() === net) {
            return { ...conn, nodes: (conn.nodes || []).filter((n) => n.toUpperCase() !== node) };
          }
          return conn;
        })
        .filter((conn) => (conn.nodes || []).length > 0);
      return `Disconnected node ${node}`;
    }
  }

  return null;
}

/**
 * Main Chat & Automation Entry Point
 */
export async function handleCircuitChat({ projectId, userId = 'default_user', message, history = [], model }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'AI_AGENT_APIKEY or FEATHERLESS_API_KEY is not configured in backend/.env. Please provide a valid Featherless key.'
    );
  }

  if (!projectId) {
    throw new Error('Missing projectId');
  }

  const activeModel = model || 'deepseek-ai/DeepSeek-V3.2';
  const circuitDef = await getProjectCircuit(projectId, userId);

  const currentSummary = `Current Circuit State for project "${projectId}":
- Total Parts: ${circuitDef.components?.length || 0}
- Components: ${(circuitDef.components || []).map((c) => `${c.ref} (${c.lib}:${c.name}, val=${c.value})`).join(', ') || 'None'}
- Connections/Nets: ${(circuitDef.connections || []).map((c) => `${c.net}: [${(c.nodes || []).join(', ')}]`).join('; ') || 'None'}`;

  // Assemble OpenAI message sequence
  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${currentSummary}` },
    ...history.slice(-10).map((h) => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.content,
    })),
    { role: 'user', content: message },
  ];

  // Run multi-turn agent loop to execute all required tools until completion
  const executedActions = [];
  let definitionModified = false;
  let turn = 0;
  const maxTurns = 8;
  let finalReply = '';

  while (turn < maxTurns) {
    turn++;
    const response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: activeModel,
        messages,
        tools: CIRCUIT_TOOLS,
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson = null;
      try { errorJson = JSON.parse(errorText); } catch {}
      const errMessage = errorJson?.error?.message || errorText || `HTTP ${response.status}`;

      if (response.status === 401) {
        throw new Error(`Featherless Authentication Failed (401): ${errMessage}. Please verify your API key.`);
      }
      if (response.status === 429) {
        throw new Error(`Featherless Concurrency Limit Reached (429): All units in use. Please wait a moment and retry.`);
      }
      throw new Error(`Featherless API Error (${response.status}): ${errMessage}`);
    }

    const completion = await response.json();
    const choice = completion.choices?.[0];
    const assistantMsg = choice?.message || {};

    const toolCalls = assistantMsg.tool_calls;

    // If model provided tool calls, execute each tool, push tool results, and loop
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      if (assistantMsg.content) {
        finalReply = assistantMsg.content;
      }
      messages.push(assistantMsg);

      for (const toolCall of toolCalls) {
        const fnName = toolCall.function?.name;
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(toolCall.function?.arguments || '{}');
        } catch {}

        const actionDesc = applyCircuitTool(circuitDef, fnName, fnArgs);
        if (actionDesc) {
          executedActions.push({ tool: fnName, args: fnArgs, description: actionDesc });
          definitionModified = true;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            status: actionDesc ? 'success' : 'noop',
            result: actionDesc || 'Tool executed',
            currentComponents: (circuitDef.components || []).map((c) => c.ref),
            currentNets: (circuitDef.connections || []).map((c) => c.net),
          }),
        });
      }

      // Continue to next turn to let the model generate the rest of the circuit
      continue;
    }

    // No native tool calls: check fallback JSON heuristic or grab final message content
    if (assistantMsg.content) {
      finalReply = assistantMsg.content;
      const jsonMatch = assistantMsg.content.match(/```(?:json)?\s*(\[\s*\{[\s\S]*?\}\s*\]|\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of list) {
            const fnName = item.action || item.tool || item.name;
            if (fnName) {
              const actionDesc = applyCircuitTool(circuitDef, fnName, item.args || item);
              if (actionDesc) {
                executedActions.push({ tool: fnName, args: item.args || item, description: actionDesc });
                definitionModified = true;
              }
            }
          }
        } catch {}
      }
    }

    // If no tool calls in this turn, agent has finished
    break;
  }

  let newVersion = circuitDef.version || 0;
  if (definitionModified) {
    const descriptions = executedActions.map((a) => a.description);
    newVersion = await saveProjectCircuit(projectId, userId, circuitDef, descriptions);
  }

  const cleanReply = (finalReply || 'I have completed updating the circuit diagram.')
    .replace(/```(?:json)?\s*\[\s*\{[\s\S]*?\}\s*\]\s*```/g, '')
    .trim();

  return {
    reply: cleanReply,
    actions: executedActions,
    newVersion,
    model: activeModel,
    circuit: {
      projectId,
      version: newVersion,
      components: circuitDef.components || [],
      connections: circuitDef.connections || [],
    },
  };
}
