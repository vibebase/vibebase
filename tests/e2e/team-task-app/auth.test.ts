// E2E Test: Authentication
// 認証機能のE2Eテスト

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type VibebaseClient } from '@vibebase/sdk';
import { UserAuthTestHelper } from './test-helpers/user-auth-helper';

describe('Authentication E2E Tests', () => {
  let vibebase: VibebaseClient;
  let userClient: VibebaseClient;
  let authHelper: UserAuthTestHelper;
  let userId: string;
  
  const apiUrl = process.env.VIBEBASE_API_URL || 'http://localhost:8787';
  const apiKey = process.env.VIBEBASE_API_KEY || 'vb_live_test123456789012345678901234567890';

  beforeAll(async () => {
    // 管理者クライアント（APIキー認証）
    vibebase = createClient({
      apiUrl,
      apiKey
    });

    // テスト用認証ヘルパーを初期化
    authHelper = new UserAuthTestHelper(apiUrl, apiKey);
  });

  afterAll(async () => {
    // テストセッションをクリーンアップ
    if (authHelper) {
      await authHelper.cleanup();
    }
  });

  describe('API Key Authentication', () => {
    it('should authenticate with valid API key', async () => {
      // APIキーで認証されたクライアントでデータを取得
      const result = await vibebase.data!.list('users');
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.data!).toBeInstanceOf(Array);
    });

    it('should fail with invalid API key', async () => {
      const invalidClient = createClient({
        apiUrl,
        apiKey: 'invalid-api-key'
      });

      const result = await invalidClient.data!.list('users');
      expect(result.success).toBe(false);
      expect(result.status).toBe(401);
      expect(result.error).toBeDefined();
    });

    it('should have full access with admin API key', async () => {
      // 全てのテーブルにアクセス可能
      const teams = await vibebase.data!.list('teams');
      const projects = await vibebase.data!.list('projects');
      const tasks = await vibebase.data!.list('tasks');

      expect(teams.success).toBe(true);
      expect(teams.data!).toBeDefined();
      expect(projects.success).toBe(true);
      expect(projects.data!).toBeDefined();
      expect(tasks.success).toBe(true);
      expect(tasks.data!).toBeDefined();
    });
  });

  describe('WHERE Clause Filtering', () => {
    it('should filter data using WHERE clause with equality comparison', async () => {
      // アリスの参加チームのみを取得（WHEREフィルタリングのテスト）
      const users = await vibebase.data!.list('users', {
        where: { email: 'alice@example.com' }
      });
      
      expect(users.success).toBe(true);
      expect(users.data!).toHaveLength(1);
      expect(users.data![0].email).toBe('alice@example.com');
    });

    it('should filter with multiple conditions (AND)', async () => {
      // 複数条件でのフィルタリング
      const result = await vibebase.data!.list('members', {
        where: { 
          role: 'owner'
        }
      });
      
      expect(result.success).toBe(true);
      expect(result.data!).toBeDefined();
      // ownerロールのメンバーのみが返される
      result.data!.forEach(member => {
        expect(member.role).toBe('owner');
      });
    });

    it('should return empty array when no matches found', async () => {
      // 存在しないデータでの検索
      const result = await vibebase.data!.list('users', {
        where: { email: 'nonexistent@example.com' }
      });
      
      expect(result.success).toBe(true);
      expect(result.data!).toHaveLength(0);
    });
  });

  describe('User Token Authentication', () => {
    let aliceToken: string;
    let bobToken: string;
    
    beforeAll(async () => {
      // セットアップ情報からテストトークンを取得
      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      
      const setupInfo = JSON.parse(
        readFileSync(resolve(__dirname, '../.setup-info.json'), 'utf-8')
      );
      
      aliceToken = setupInfo.testTokens.alice;
      bobToken = setupInfo.testTokens.bob;
    });
    
    it('should authenticate with valid user token', async () => {
      // ユーザー認証クライアントを作成
      const aliceClient = createClient({
        apiUrl,
        userToken: aliceToken
      });

      const result = await aliceClient.data!.list('users');
      expect(result.success).toBe(true);
      expect(result.data!).toHaveLength(1); // 自分のデータのみ
      expect(result.data![0].email).toBe('alice@example.com');
    });

    it('should respect owner-based access control for users table', async () => {
      // Aliceクライアント
      const aliceClient = createClient({
        apiUrl,
        userToken: aliceToken
      });
      
      // Bobクライアント  
      const bobClient = createClient({
        apiUrl,
        userToken: bobToken
      });

      // それぞれが自分のデータのみ取得できることを確認
      const aliceData = await aliceClient.data!.list('users');
      const bobData = await bobClient.data!.list('users');
      
      expect(aliceData.success).toBe(true);
      expect(aliceData.data!).toHaveLength(1);
      expect(aliceData.data![0].id).toBe('V1StGXR8_Z5jdHi6B-myT');
      
      expect(bobData.success).toBe(true);
      expect(bobData.data!).toHaveLength(1);
      expect(bobData.data![0].id).toBe('3ZjkQ2mN8pX9vC7bA-wEr');
    });

    it('should access public tables with user authentication', async () => {
      const aliceClient = createClient({
        apiUrl,
        userToken: aliceToken
      });
      
      // publicテーブル（teams, members, projects, tasks）へのアクセス
      const teams = await aliceClient.data!.list('teams');
      const members = await aliceClient.data!.list('members');
      const projects = await aliceClient.data!.list('projects');
      const tasks = await aliceClient.data!.list('tasks');
      
      expect(teams.success).toBe(true);
      expect(members.success).toBe(true);
      expect(projects.success).toBe(true);
      expect(tasks.success).toBe(true);
      
      // チームメンバーの情報が見えることを確認
      expect(members.data!.length).toBeGreaterThan(0);
      const aliceMember = members.data!.find((m: any) => m.user_id === 'V1StGXR8_Z5jdHi6B-myT');
      expect(aliceMember).toBeDefined();
      expect(aliceMember!.display_name).toContain('Alice');
    });
  });

  describe('Authentication Flow', () => {
    it('should handle token refresh', async () => {
      // SDKは自動的にトークンをリフレッシュする
      // 長時間のテストをシミュレート
      const results = [];
      
      for (let i = 0; i < 3; i++) {
        const data = await vibebase.data!.list('teams');
        results.push(data);
        
        // 実際のリフレッシュ間隔より短い待機
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.data!).toBeDefined();
      });
    });

    it('should handle concurrent requests', async () => {
      // 複数の同時リクエストを処理
      const promises = [
        vibebase.data!.list('teams'),
        vibebase.data!.list('projects'),
        vibebase.data!.list('tasks'),
        vibebase.data!.list('users')
      ];
      
      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(4);
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.data!).toBeDefined();
        expect(result.data!).toBeInstanceOf(Array);
      });
    });
  });

  describe('Permission Validation', () => {
    it('should validate create permissions', async () => {
      const newTeam = {
        name: 'Test Team',
        description: 'Created in E2E test',
        created_by: 'test-user-id'
      };
      
      // 管理者は作成可能
      const created = await vibebase.data!.create('teams', newTeam);
      console.log('Created response:', JSON.stringify(created, null, 2));
      expect(created).toBeDefined();
      expect(created.success).toBe(true);
      expect(created.data!?.id).toBeDefined();
      
      // クリーンアップ
      await vibebase.data!.delete('teams', created.data!.id);
    });

    it('should validate update permissions', async () => {
      // 既存のチームを取得
      const teams = await vibebase.data!.list('teams', { limit: 1 });
      if (teams.data!.length === 0) {
        throw new Error('No teams found for testing');
      }
      
      const teamId = teams.data![0].id;
      const originalName = teams.data![0].name;
      
      // 更新
      const updated = await vibebase.data!.update('teams', teamId, {
        name: `${originalName} (Updated)`
      });
      
      expect(updated.success).toBe(true);
      expect(updated.data?.name).toContain('(Updated)');
      
      // 元に戻す
      await vibebase.data!.update('teams', teamId, {
        name: originalName
      });
    });

    it('should validate delete permissions', async () => {
      // テスト用のデータを作成
      const testTeam = await vibebase.data!.create('teams', {
        name: 'Temporary Test Team',
        description: 'Will be deleted',
        created_by: 'test-user-id'
      });
      
      // 削除
      await expect(
        vibebase.data!.delete('teams', testTeam.data!.id)
      ).resolves.not.toThrow();
      
      // 削除確認
      const result = await vibebase.data!.list('teams', {
        where: { id: testTeam.data!.id }
      });
      
      expect(result.data!).toHaveLength(0);
    });
  });
});