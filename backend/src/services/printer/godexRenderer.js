class GodexRenderer {
  normalizeTemplate(template, variables = {}) {
    const definition = typeof template.definition === 'string' ? JSON.parse(template.definition) : template.definition;
    if (!definition || typeof definition !== 'object') throw new Error('invalid_label_template');
    const fields = (definition.fields || []).map((field) => ({
      ...field,
      value: String(Object.prototype.hasOwnProperty.call(variables, field.key) ? variables[field.key] : (field.value ?? '')),
    }));
    return { name: template.name, width: definition.width, height: definition.height, fields };
  }
  render(template, variables, commandLanguage, { demo = false } = {}) {
    const logicalLabel = this.normalizeTemplate(template, variables);
    if (demo) return JSON.stringify({ simulated: true, commandLanguage: commandLanguage || null, logicalLabel });
    if (!commandLanguage) throw new Error('printer_language_not_configured');
    throw new Error(`printer_language_not_supported:${commandLanguage}`);
  }
}
module.exports = new GodexRenderer();
