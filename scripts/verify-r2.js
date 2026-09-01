import { readdir } from 'fs/promises';
import { existsSync } from 'fs';

async function verify() {
  const baseUrl = 'https://pub-a4f1a10b0b2a43bc8d00e99351737b28.r2.dev/Symbols';

  // Test critical and sample components across the entire spectrum (A-Z)
  const samples = [
    '4xxx.kicad_symdir/4001.kicad_sym',
    '74xx.kicad_symdir/74LS00.kicad_sym',
    'Amplifier_Operational.kicad_symdir/LM358.kicad_sym',
    'Connector_Generic.kicad_symdir/Conn_01x04.kicad_sym',
    'Device.kicad_symdir/R.kicad_sym',
    'Device.kicad_symdir/C.kicad_sym',
    'Device.kicad_symdir/LED.kicad_sym',
    'Diode.kicad_symdir/1N4148.kicad_sym',
    'MCU_Espressif.kicad_symdir/ESP32-PICO-D4.kicad_sym',
    'MCU_Microchip_ATmega.kicad_symdir/ATmega328P-P.kicad_sym',
    'MCU_Module.kicad_symdir/Arduino_Nano_v3.x.kicad_sym',
    'MCU_RaspberryPi.kicad_symdir/RP2040.kicad_sym',
    'Regulator_Linear.kicad_symdir/AMS1117-3.3.kicad_sym',
    'Regulator_Linear.kicad_symdir/LM7805_TO220.kicad_sym',
    'Sensor.kicad_symdir/DHT11.kicad_sym',
    'Sensor_Optical.kicad_symdir/LDR07.kicad_sym',
    'Switch.kicad_symdir/SW_Push.kicad_sym',
    'Transistor_BJT.kicad_symdir/2N2222A.kicad_sym',
    'Transistor_FET.kicad_symdir/2N7000.kicad_sym',
    'Triac_Thyristor.kicad_symdir/BT136-600.kicad_sym',
  ];

  console.log('Testing Cloudflare R2 public endpoint...');
  let passed = 0;

  for (const sample of samples) {
    const url = `${baseUrl}/${sample}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`✅ [200 OK] ${sample}`);
        passed++;
      } else {
        console.log(`❌ [${res.status}] ${sample}`);
      }
    } catch (err) {
      console.log(`❌ [ERROR] ${sample}: ${err.message}`);
    }
  }

  console.log(`\nVerification Result: ${passed}/${samples.length} sampled component symbols verified on Cloudflare R2!`);
}

verify();
