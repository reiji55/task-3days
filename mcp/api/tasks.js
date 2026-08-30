// ビューアから叩く /api/tasks。GITHUB_TOKEN はここから先にしか出ない。
import { createTasksApi } from '../lib/tasks-api.js';

export default createTasksApi();
