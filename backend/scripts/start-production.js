// Explicit production entrypoint used by both npm start and the Windows service.
process.env.NODE_ENV = 'production';
process.env.HOST ||= '0.0.0.0';
process.env.PORT ||= '80';

require('../src/app');
