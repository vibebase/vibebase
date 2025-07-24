// E2E Test: Realtime Assignment Notifications (Isolated)
// リアルタイムタスク割り当て通知専用テスト（完全分離）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type VibebaseClient } from '@vibebase/sdk';
import type { Task, Team, Project } from './fixtures/types';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Node.js環境でEventSourceを使用するためのポリフィル
import { EventSource } from 'eventsource';
global.EventSource = EventSource as any;

// セットアップ情報を読み込み
const setupInfo = JSON.parse(
  readFileSync(resolve(__dirname, '../.setup-info.json'), 'utf-8')
);

const API_URL = setupInfo.apiUrl;
const testTokens = setupInfo.testTokens;

describe('Realtime Assignment Notifications (Isolated)', () => {
  // 各ユーザーのクライアント
  let aliceClient: VibebaseClient;
  let bobClient: VibebaseClient;
  
  let testTeam: Team;
  let testProject: Project;
  let createdHookIds: string[] = [];
  let createdTaskIds: string[] = [];

  beforeAll(async () => {
    // ユーザー認証クライアントを初期化
    aliceClient = createClient({ apiUrl: API_URL, userToken: testTokens.alice });
    bobClient = createClient({ apiUrl: API_URL, userToken: testTokens.bob });

    // テスト用のチームとプロジェクトを作成（分離用）
    const teamResponse = await aliceClient.data!.create('teams', {
      name: 'Assignment Test Team ISOLATED',
      description: 'Team for isolated assignment testing',
      created_by: 'V1StGXR8_Z5jdHi6B-myT' // Alice
    });
    testTeam = teamResponse.success ? teamResponse.data! : teamResponse as any;

    const projectResponse = await aliceClient.data!.create('projects', {
      team_id: testTeam.id,
      name: 'Assignment Test Project ISOLATED',
      description: 'Project for isolated assignment testing',
      status: 'active',
      created_by: 'V1StGXR8_Z5jdHi6B-myT' // Alice
    });
    testProject = projectResponse.success ? projectResponse.data! : projectResponse as any;

    // タスクのinsertフック作成（割り当て通知用）
    try {
      const insertHook = await aliceClient.realtimeManager.createHook('tasks', 'insert');
      if (insertHook.success) {
        createdHookIds.push(insertHook.data!.id);
        console.log('✅ Created INSERT hook for isolated assignment testing');
      }
    } catch (error) {
      console.warn('Failed to create hooks:', error);
    }
    
    // 完全に独立したリアルタイム環境を保証するため長めの待機
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  afterAll(async () => {
    // フックとタスクをクリーンアップ
    for (const hookId of createdHookIds) {
      try {
        await aliceClient.realtimeManager.deleteHook(hookId);
      } catch (error) {
        // エラーは無視
      }
    }
    
    for (const taskId of createdTaskIds) {
      try {
        await aliceClient.data!.delete('tasks', taskId);
      } catch (error) {
        // エラーは無視
      }
    }

    if (testProject) {
      await aliceClient.data!.delete('projects', testProject.id);
    }
    if (testTeam) {
      await aliceClient.data!.delete('teams', testTeam.id);
    }

    // リアルタイム接続をクリーンアップ
    aliceClient.realtime.unsubscribeAll();
    bobClient.realtime.unsubscribeAll();
    if (aliceClient.realtime.isConnected()) {
      aliceClient.realtime.disconnect();
    }
    if (bobClient.realtime.isConnected()) {
      bobClient.realtime.disconnect();
    }
  });

  it('should handle task assignment notifications in complete isolation', async () => {
    // 完全分離のための初期クリーンアップ
    aliceClient.realtime.unsubscribeAll();
    bobClient.realtime.unsubscribeAll();
    if (aliceClient.realtime.isConnected()) {
      aliceClient.realtime.disconnect();
    }
    if (bobClient.realtime.isConnected()) {
      bobClient.realtime.disconnect();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 他のテストとの分離のために超独特なタスク名
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    const uniqueTaskTitle = `ISOLATED_ASSIGNMENT_TEST_${timestamp}_${random}`;
    
    console.log(`🔥 Starting ISOLATED assignment test with title: ${uniqueTaskTitle}`);
    
    // Alice が SSE に接続
    aliceClient.realtime.connect();
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(aliceClient.realtime.isConnected()).toBe(true);
    
    let assignmentReceived = false;
    const subscription = aliceClient.realtime.subscribe('tasks', '*', (event) => {
      console.log('📨 ISOLATED ASSIGNMENT TEST received:', JSON.stringify(event, null, 2));
      
      if (event.table === 'tasks' && event.eventType === 'insert' && event.data?.title === uniqueTaskTitle) {
        console.log('✅ ISOLATED ASSIGNMENT: Event matched our task!');
        assignmentReceived = true;
      } else {
        console.log('❌ ISOLATED ASSIGNMENT: Event ignored (not our task)');
      }
    });
    
    // サブスクリプションが安定するまで待機
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Bob が Alice にタスクをアサイン
    console.log(`🚀 Bob creating assignment task: ${uniqueTaskTitle}`);
    const assignmentTask = await bobClient.data!.create<Task>('tasks', {
      project_id: testProject.id,
      title: uniqueTaskTitle,
      description: 'Task assigned to Alice for isolated notification testing',
      status: 'todo' as const,
      priority: 'urgent' as const,
      created_by: '3ZjkQ2mN8pX9vC7bA-wEr', // Bob
      assigned_to: 'V1StGXR8_Z5jdHi6B-myT' // Alice
    });
    
    expect(assignmentTask.success).toBe(true);
    createdTaskIds.push(assignmentTask.data!.id);
    console.log(`✅ Assignment task created with ID: ${assignmentTask.data!.id}`);
    
    // イベント受信を十分に待機
    console.log('🕰️ Waiting for ISOLATED assignment event...');
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    // 実際のフック動作確認
    expect(assignmentTask.success).toBe(true);
    expect(assignmentTask.data!.assigned_to).toBe('V1StGXR8_Z5jdHi6B-myT');
    expect(assignmentTask.data!.title).toBe(uniqueTaskTitle);
    
    if (!assignmentReceived) {
      console.log('❌ ISOLATED ASSIGNMENT: No matching events received');
      console.log('Task ID:', assignmentTask.data!.id);
      console.log('Task Title:', uniqueTaskTitle);
      console.log('Is Alice connected:', aliceClient.realtime.isConnected());
      
      throw new Error(`ISOLATED ASSIGNMENT TEST FAILED: No events received for task ${assignmentTask.data!.id} with title ${uniqueTaskTitle}`);
    }
    
    expect(assignmentReceived).toBe(true); // 実データ更新による実リアルタイムイベント受信を確認
    console.log(`✅ ISOLATED ASSIGNMENT TEST PASSED: Event received for task ${assignmentTask.data!.id}`);
    
    subscription.unsubscribe();
    aliceClient.realtime.disconnect();
    
    // 接続クリーンアップ後の待機
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 90000); // 90秒のタイムアウト
});