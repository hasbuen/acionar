const test = require('node:test');
const assert = require('node:assert/strict');

const { formatDateInputValue, formatTimeInputValue, toLocalDateTimeISO, addDaysToDateInput } = require('../js/datetime.js');

test('converte data e hora selecionadas em ISO preservando o horário local', () => {
  const iso = toLocalDateTimeISO('2026-07-30', '09:15');
  const d = new Date(iso);

  assert.equal(formatDateInputValue(d), '2026-07-30');
  assert.equal(formatTimeInputValue(d), '09:15');
});

test('adiciona dias mantendo o formato de input de data', () => {
  assert.equal(addDaysToDateInput('2026-07-30', 15), '2026-08-15');
  assert.equal(addDaysToDateInput('2026-07-30', 30), '2026-08-30');
});
