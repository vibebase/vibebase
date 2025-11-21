// E2E Test: Realtime Delete Events (Isolated)
// リアルタイム削除イベント専用テスト（完全分離）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type VibebaseClient } from '@vibebase/sdk';
import type { Team, Project, Task, User } from './fixtures/types';

// Node.js環境でEventSourceを使用するためのポリフィル
import { EventSource } from 'eventsource';
global.EventSource = EventSource as any;

describe('Realtime Delete Events (Isolated)', () => {
  let vibebase: VibebaseClient;
  let testTeam: Team;
  let testProject: Project;
  let testUsers: User[] = [];
  let createdTaskIds: string[] = [];

  const apiUrl = process.env.VIBEBASE_API_URL || 'http://localhost:8787';
  const apiKey = process.env.VIBEBASE_API_KEY || 'vb_live_test123456789012345678901234567890';

  beforeAll(async () => {
    vibebase = createClient({
      apiUrl,
      apiKey
    });

    // テストユーザーを取得
    const userEmails = ['alice@example.com', 'bob@example.com'];
    for (const email of userEmails) {
      const result = await vibebase.data!.list('users', {
        where: { email }
      });
      if (result.data!.length > 0) {
        testUsers.push(result.data![0] as unknown as User);
      }
    }

    // テスト用のチームとプロジェクトを作成
    const teamResponse = await vibebase.data!.create('teams', {
      name: 'Delete Test Team ISOLATED',
      description: 'Team for isolated delete testing',
      created_by: testUsers[0].id
    });
    testTeam = teamResponse.success ? teamResponse.data! : teamResponse as any;

    const projectResponse = await vibebase.data!.create('projects', {
      team_id: testTeam.id,
      name: 'Delete Test Project ISOLATED',
      description: 'Project for isolated delete testing',
      status: 'active',
      created_by: testUsers[0].id
    });
    testProject = projectResponse.success ? projectResponse.data! : projectResponse as any;

    // テスト用のフックを作成（削除専用）
    try {
      await vibebase.realtimeManager.createHook('tasks', 'delete');
      console.log('✅ Created DELETE hook for isolated testing');
    } catch (error) {
      console.warn('Failed to create hooks:', error);
    }

    // 完全に独立したリアルタイム環境を保証するため長めの待機
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  afterAll(async () => {
    // クリーンアップ
    for (const taskId of createdTaskIds) {
      try {
        await vibebase.data!.delete('tasks', taskId);
      } catch (error) {
        console.warn(`Failed to cleanup task ${taskId}:`, error);
      }
    }

    if (testProject) {
      await vibebase.data!.delete('projects', testProject.id);
    }
    if (testTeam) {
      await vibebase.data!.delete('teams', testTeam.id);
    }

    // リアルタイム接続をクリーンアップ
    vibebase.realtime.unsubscribeAll();
    if (vibebase.realtime.isConnected()) {
      vibebase.realtime.disconnect();
    }
  });

  it('should receive delete events in complete isolation', async () => {
    // 完全分離のための初期クリーンアップ
    vibebase.realtime.unsubscribeAll();
    if (vibebase.realtime.isConnected()) {
      vibebase.realtime.disconnect();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));

    const events: any[] = [];

    // 超独特なタスク名(ミリ秒 + ランダム + 専用プレフィックス)
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    const uniqueTaskTitle = `ISOLATED_DELETE_TEST_${timestamp}_${random}`;

    console.log(`🔥 Starting ISOLATED delete test with title: ${uniqueTaskTitle}`);

    // 新しい接続を開始
    vibebase.realtime.connect();
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(vibebase.realtime.isConnected()).toBe(true);

    // タスクIDを保存する変数
    let taskId: string | null = null;

    // 超限定的なイベントフィルタリング
    const subscription = vibebase.realtime.subscribe('tasks', '*', (event) => {
      console.log(`📨 ISOLATED DELETE TEST received:`, JSON.stringify(event, null, 2));

      // このテストのタスクのみを受け入れる(超限定的)
      const isOurTask = event.table === 'tasks' && (
        (event.data?.title === uniqueTaskTitle) ||
        (taskId && event.recordId === taskId)
      );

      if (isOurTask) {
        console.log(`✅ ISOLATED DELETE: Event matched our task!`);
        events.push(event);
      } else {
        console.log(`❌ ISOLATED DELETE: Event ignored (not our task)`);
      }
    });

    // サブスクリプションの安定を待つ
    await new Promise(resolve => setTimeout(resolve, 2000));

    // タスクを作成
    console.log(`🚀 Creating ISOLATED task: ${uniqueTaskTitle}`);
    const taskResponse = await vibebase.data!.create('tasks', {
      project_id: testProject.id,
      title: uniqueTaskTitle,
      status: 'todo',
      priority: 'low',
      created_by: testUsers[0].id
    });
    const task = taskResponse.success ? taskResponse.data! : taskResponse as any;
    taskId = task.id;
    if (taskId) {
      createdTaskIds.push(taskId);
    }
    console.log(`✅ ISOLATED Task created with ID: ${taskId}`);

    // 作成イベントが届くまで待機
    await new Promise(resolve => setTimeout(resolve, 2000));

    // タスクを削除
    console.log(`🗑️ Deleting ISOLATED task: ${taskId} (${uniqueTaskTitle})`);
    await vibebase.data!.delete('tasks', task.id);

    // 削除イベントが届くまで十分待機
    console.log('🕰️ Waiting for ISOLATED delete event...');
    await new Promise(resolve => setTimeout(resolve, 6000)); // 6秒待機

    // 結果の確認
    console.log('DEBUG ISOLATED: Total filtered events received:', events.length);
    console.log('DEBUG ISOLATED: Filtered Events:', JSON.stringify(events, null, 2));

    if (events.length === 0) {
      console.log('❌ ISOLATED: No events received at all');
      console.log('Task ID:', taskId);
      console.log('Unique Title:', uniqueTaskTitle);
      console.log('Is connected:', vibebase.realtime.isConnected());

      // デバッグ情報をさらに詳細に出力
      throw new Error(`ISOLATED DELETE TEST FAILED: No events received for task ${taskId} with title ${uniqueTaskTitle}`);
    }

    expect(events.length).toBeGreaterThan(0);

    const deleteEvents = events.filter(e => e.type === 'event' && e.eventType === 'delete' && e.table === 'tasks');
    console.log('DEBUG ISOLATED: Delete events found:', deleteEvents.length);
    expect(deleteEvents.length).toBeGreaterThan(0);

    // 削除したタスクのイベントを確認
    const taskDeleteEvent = deleteEvents.find(e => e.recordId === task.id);
    expect(taskDeleteEvent).toBeDefined();
    console.log(`✅ ISOLATED DELETE TEST PASSED: Delete event confirmed for task ${task.id}`);

    subscription.unsubscribe();

    // 最後のクリーンアップ
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 90000); // 90秒のタイムアウト
});
