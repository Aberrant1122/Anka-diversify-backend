import express from 'express';
import { App } from './app';

const app = express();
const port = process.env.PORT || 3000;

app.use('/', App);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export { app, port };