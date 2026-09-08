function hasComponent(components, terms) {
  return components.some((component) => {
    const identity = `${component.name || ''} ${component.value || ''} ${component.lib || ''}`.toLowerCase()
    return terms.some((term) => identity.includes(term))
  })
}

function findPin(connections, ref, fallback) {
  const prefix = `${ref.toUpperCase()}.`
  for (const connection of connections || []) {
    const node = (connection.nodes || []).find((item) => item.toUpperCase().startsWith(prefix))
    if (!node) continue
    const peer = (connection.nodes || []).find((item) => item !== node && /^U\d+\./i.test(item))
    if (peer) return peer.split('.').slice(1).join('.').replace(/^IO/i, '')
  }
  return fallback
}

export function generateAutomationFirmware(definition) {
  const components = Array.isArray(definition?.components) ? definition.components : []
  const connections = Array.isArray(definition?.connections) ? definition.connections : []
  const dht = hasComponent(components, ['dht'])
  const pir = hasComponent(components, ['pir', 'motion', 'ld2110', 'radar'])
  const relay = hasComponent(components, ['relay'])
  const led = hasComponent(components, ['led'])
  const oled = hasComponent(components, ['oled', 'ssd1306', 'sh1106', 'gme12864'])
  const dhtPin = findPin(connections, components.find((c) => `${c.name} ${c.value}`.toLowerCase().includes('dht'))?.ref || 'DHT1', '4')
  const pirPin = findPin(connections, components.find((c) => `${c.name} ${c.value}`.toLowerCase().match(/pir|motion|ld2110|radar/))?.ref || 'SEN1', '14')
  const relayPin = findPin(connections, components.find((c) => `${c.name} ${c.value}`.toLowerCase().includes('relay'))?.ref || 'K1', '26')
  const ledPin = findPin(connections, components.find((c) => `${c.name} ${c.value}`.toLowerCase().includes('led'))?.ref || 'D1', '2')
  const includes = ['#include <Arduino.h>']
  if (dht) includes.push('#include <DHT.h>')
  if (oled) includes.push('#include <Wire.h>', '#include <Adafruit_GFX.h>', '#include <Adafruit_SSD1306.h>')
  const declarations = []
  if (dht) declarations.push(`#define DHT_PIN ${dhtPin}`, '#define DHT_TYPE DHT22', 'DHT dht(DHT_PIN, DHT_TYPE);')
  if (pir) declarations.push(`#define MOTION_PIN ${pirPin}`)
  if (relay) declarations.push(`#define RELAY_PIN ${relayPin}`)
  if (led) declarations.push(`#define LED_PIN ${ledPin}`)
  if (oled) declarations.push('Adafruit_SSD1306 display(128, 64, &Wire, -1);')
  const setup = []
  if (dht) setup.push('  dht.begin();')
  if (pir) setup.push('  pinMode(MOTION_PIN, INPUT);')
  if (relay) setup.push('  pinMode(RELAY_PIN, OUTPUT);')
  if (led) setup.push('  pinMode(LED_PIN, OUTPUT);')
  if (oled) setup.push('  Wire.begin(21, 22);', '  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);')
  const loop = []
  if (dht) loop.push('  float temperature = dht.readTemperature();', '  Serial.printf("temperature=%.1f\\n", temperature);')
  if (pir) loop.push('  bool motion = digitalRead(MOTION_PIN);', '  Serial.printf("motion=%d\\n", motion);')
  const activeExpression = pir && dht ? '(motion || (temperature > 28.0))' : pir ? 'motion' : dht ? '(temperature > 28.0)' : 'true'
  if (relay) loop.push(`  digitalWrite(RELAY_PIN, ${activeExpression} ? HIGH : LOW);`)
  if (led) loop.push(`  digitalWrite(LED_PIN, ${activeExpression} ? HIGH : LOW);`)
  if (oled) loop.push('  display.clearDisplay();', '  display.setTextSize(1);', '  display.setTextColor(SSD1306_WHITE);', '  display.setCursor(0, 0);', '  display.println("Chip automation");', '  display.display();')
  if (loop.length === 0) loop.push('  Serial.println("automation=ready");')
  return `${includes.join('\n')}\n\n${declarations.join('\n')}\n\nvoid setup() {\n  Serial.begin(115200);\n${setup.join('\n')}\n}\n\nvoid loop() {\n${loop.join('\n')}\n  delay(1000);\n}\n`
}
