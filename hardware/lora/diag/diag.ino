/*
  Indradhanu node diagnostics. Upload, open Serial Monitor at 115200, copy everything it prints.
  It talks to the SX1278 directly (no LoRa library) and checks every sensor pin.
  Upload node.ino again afterwards.
*/
#include <SPI.h>
#include <Wire.h>
#include <OneWire.h>

const int NSS = 10, RST = 9, DIO0 = 2;

uint8_t readReg(uint8_t reg, uint32_t hz) {
  SPI.beginTransaction(SPISettings(hz, MSBFIRST, SPI_MODE0));
  digitalWrite(NSS, LOW);
  delayMicroseconds(20);
  SPI.transfer(reg & 0x7F);
  uint8_t v = SPI.transfer(0x00);
  delayMicroseconds(20);
  digitalWrite(NSS, HIGH);
  SPI.endTransaction();
  return v;
}

void hex2(uint8_t v) { if (v < 16) Serial.print('0'); Serial.print(v, HEX); }

void radio() {
  Serial.println(F("\n== RADIO (SX1278 chip ID register 0x42 must read 12) =="));
  pinMode(NSS, OUTPUT); digitalWrite(NSS, HIGH);
  pinMode(RST, OUTPUT);
  digitalWrite(RST, LOW); delay(10); digitalWrite(RST, HIGH); delay(20);
  SPI.begin();
  const uint32_t speeds[] = {1000000UL, 250000UL, 62500UL};
  bool ok = false;
  for (uint32_t hz : speeds) {
    Serial.print(F("  SPI ")); Serial.print(hz / 1000); Serial.print(F(" kHz -> "));
    for (int i = 0; i < 4; i++) { hex2(readReg(0x42, hz)); Serial.print(' '); }
    uint8_t v = readReg(0x42, hz);
    if (v == 0x12) { Serial.println(F(" OK")); ok = true; }
    else if (v == 0x00) Serial.println(F(" all 00: MISO stuck low, or radio has no power/GND"));
    else if (v == 0xFF) Serial.println(F(" all FF: MISO not connected, or NSS/SCK/MOSI not reaching the radio"));
    else Serial.println(F(" wrong value: loose wire or wrong pin order"));
  }
  Serial.print(F("  Pin D12 (MISO) idle level: ")); pinMode(12, INPUT); Serial.println(digitalRead(12));
  Serial.print(F("  Pin D2  (DIO0) level: ")); pinMode(DIO0, INPUT); Serial.println(digitalRead(DIO0));
  Serial.println(ok ? F("  RADIO: FOUND") : F("  RADIO: NOT FOUND"));
}

void i2c() {
  Serial.println(F("\n== I2C (A4/A5): MPU-6050 = 68 or 69, LCD = 27 or 3F =="));
  Wire.begin();
  int n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.print(F("  found 0x")); hex2(a); Serial.println(); n++; }
  }
  if (!n) Serial.println(F("  nothing: check SDA->A4, SCL->A5, VCC->5V, GND->GND"));
}

void analogPins() {
  Serial.println(F("\n== ANALOG (normal value | with pull-up; 1023 with pull-up = nothing connected) =="));
  const char *names[] = {"A0 MQ-2", "A1 MQ-135", "A2 piezo", "A3 sound"};
  for (int i = 0; i < 4; i++) {
    pinMode(A0 + i, INPUT); delay(5);
    int a = analogRead(A0 + i);
    pinMode(A0 + i, INPUT_PULLUP); delay(5);
    int b = analogRead(A0 + i);
    pinMode(A0 + i, INPUT);
    Serial.print(F("  ")); Serial.print(names[i]); Serial.print(F(": ")); Serial.print(a);
    Serial.print(F(" | ")); Serial.println(b);
  }
}

void oneWire() {
  Serial.println(F("\n== DS18B20 probe on D4 =="));
  OneWire ow(4);
  uint8_t addr[8]; int n = 0;
  ow.reset_search();
  while (ow.search(addr)) n++;
  Serial.print(F("  probes found: ")); Serial.println(n);
  if (!n) Serial.println(F("  none: yellow->D4, red->5V, black->GND, 10k between yellow and red"));
}

void tilt() {
  Serial.println(F("\n== Tilt switch on D5 (tip the board while this runs) =="));
  pinMode(5, INPUT_PULLUP);
  int lows = 0;
  for (int i = 0; i < 50; i++) { if (digitalRead(5) == LOW) lows++; delay(20); }
  Serial.print(F("  closed in ")); Serial.print(lows); Serial.println(F(" of 50 samples (0 = never closed)"));
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n##### INDRADHANU NODE DIAGNOSTICS #####"));
  Serial.print(F("Supply (5V pin, from internal ref): "));
  // read VCC against the 1.1 V bandgap
  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);
  delay(5); ADCSRA |= _BV(ADSC); while (bit_is_set(ADCSRA, ADSC));
  long vcc = 1125300L / ADC;
  Serial.print(vcc); Serial.println(F(" mV (should be 4700-5200)"));
  analogReference(DEFAULT); analogRead(A0);
  radio();
  i2c();
  analogPins();
  oneWire();
  tilt();
  Serial.println(F("\n##### DONE. Repeats every 15 s. #####"));
}

void loop() {
  delay(15000);
  radio();
}
