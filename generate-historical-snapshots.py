#!/usr/bin/env python3
"""
usagi-limit 歷史 Snapshot 生成器
從 FinLab 資料生成歷史漲停股票 snapshot JSON
"""

import pandas as pd
import json
import os
import sys
from datetime import datetime, date
import numpy as np

# 配置
FINLAB_DATA_DIR = "D:/claude-auto/finlab-data"
SNAPSHOT_DIR = "./snapshots"
COMPANY_INFO_FILE = os.path.join(FINLAB_DATA_DIR, "company_basic_info.csv")

# 漲停判斷的 tick 規則（從 generate.mjs 移植）
def get_tick(price):
    """計算升降單位 tick"""
    if price < 10:
        return 0.01
    elif price < 50:
        return 0.05
    elif price < 100:
        return 0.1
    elif price < 500:
        return 0.5
    elif price < 1000:
        return 1
    else:
        return 5

def calc_limit_up_price(prev_close):
    """計算漲停價格"""
    if pd.isna(prev_close) or prev_close <= 0:
        return None
    tick = get_tick(prev_close)
    limit_up = prev_close * 1.10
    return int(limit_up / tick) * tick

def is_limit_up(close, prev_close):
    """判斷是否漲停"""
    if pd.isna(close) or pd.isna(prev_close) or prev_close <= 0:
        return False

    limit_up_price = calc_limit_up_price(prev_close)
    if limit_up_price is None:
        return False

    # 允許微小誤差（浮點數精度）
    return abs(close - limit_up_price) < 0.001

def load_company_names():
    """載入公司名稱映射"""
    try:
        df = pd.read_csv(COMPANY_INFO_FILE, encoding='utf-8-sig')
        # 假設欄位名稱，可能需要調整
        name_mapping = {}
        for _, row in df.iterrows():
            # 嘗試不同可能的欄位名稱
            code = None
            name = None

            for col in df.columns:
                col_lower = col.lower()
                if any(keyword in col_lower for keyword in ['代號', 'code', '股票代號', 'stock_id']):
                    code = str(row[col]).strip() if pd.notna(row[col]) else None
                elif any(keyword in col_lower for keyword in ['名稱', 'name', '公司名稱', '公司簡稱']):
                    name = str(row[col]).strip() if pd.notna(row[col]) else None

            if code and name and len(code) == 4 and code.isdigit():
                name_mapping[code] = name

        print(f"載入 {len(name_mapping)} 個公司名稱映射")
        return name_mapping

    except Exception as e:
        print(f"Warning: 無法載入公司名稱 ({e})，將使用股票代號")
        return {}

def filter_stock_codes(df):
    """過濾只保留 4 位數一般股票（排除 ETF、權證）"""
    valid_codes = []
    for col in df.columns:
        if col != 'date' and len(str(col)) == 4 and str(col).isdigit():
            valid_codes.append(col)

    return df[['date'] + valid_codes] if 'date' in df.columns else df[valid_codes]

def generate_snapshots(start_date=None, end_date=None):
    """生成歷史 snapshot"""
    print("=== usagi-limit 歷史 Snapshot 生成器 ===")

    # 確保輸出目錄存在
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)

    # 載入資料
    print("載入 FinLab 資料...")

    close_file = os.path.join(FINLAB_DATA_DIR, "price_收盤價.csv")
    volume_file = os.path.join(FINLAB_DATA_DIR, "price_成交股數.csv")

    if not os.path.exists(close_file):
        raise FileNotFoundError(f"找不到收盤價檔案: {close_file}")
    if not os.path.exists(volume_file):
        raise FileNotFoundError(f"找不到成交股數檔案: {volume_file}")

    # 載入價格和成交量
    print("  讀取收盤價...")
    df_close = pd.read_csv(close_file, index_col=0, parse_dates=True)
    df_close = filter_stock_codes(df_close)

    print("  讀取成交股數...")
    df_volume = pd.read_csv(volume_file, index_col=0, parse_dates=True)
    df_volume = filter_stock_codes(df_volume)

    # 載入公司名稱
    company_names = load_company_names()

    # 日期過濾
    if start_date:
        df_close = df_close[df_close.index >= start_date]
        df_volume = df_volume[df_volume.index >= start_date]
    if end_date:
        df_close = df_close[df_close.index <= end_date]
        df_volume = df_volume[df_volume.index <= end_date]

    print(f"  處理日期範圍: {df_close.index.min()} 到 {df_close.index.max()}")
    print(f"  股票數量: {len(df_close.columns)}")
    print(f"  交易日數: {len(df_close)}")

    generated_count = 0

    # 逐日處理
    for i in range(1, len(df_close)):  # 從第二天開始（需要前一天收盤價）
        current_date = df_close.index[i]
        prev_date = df_close.index[i-1]

        date_str = current_date.strftime('%Y%m%d')

        # 檢查是否已存在
        snapshot_file = os.path.join(SNAPSHOT_DIR, f"{date_str}.json")
        if os.path.exists(snapshot_file):
            continue  # 跳過已存在的

        print(f"處理 {current_date.strftime('%Y-%m-%d')}...")

        # 當日和前日價格
        today_close = df_close.iloc[i]
        yesterday_close = df_close.iloc[i-1]

        # 當日成交量
        today_volume = df_volume.iloc[i] if i < len(df_volume) else pd.Series()

        limit_stocks = {}
        limit_count = 0

        # 檢查每支股票
        for code in df_close.columns:
            close = today_close.get(code)
            prev_close = yesterday_close.get(code)
            volume = today_volume.get(code, 0)

            # 跳過無效資料
            if pd.isna(close) or pd.isna(prev_close) or close <= 0 or prev_close <= 0:
                continue

            # 判斷漲停
            if is_limit_up(close, prev_close):
                change = close - prev_close
                change_pct = (change / prev_close) * 100

                # 取得公司名稱
                name = company_names.get(code, code)

                limit_stocks[code] = {
                    "code": code,
                    "name": name,
                    "close": round(close, 2),
                    "change": round(change, 2),
                    "changePct": f"{change_pct:.2f}",
                    "volume": int(volume) if pd.notna(volume) and volume > 0 else 0,
                    "type": "漲停"
                }

                limit_count += 1

        # 儲存 snapshot
        if limit_stocks:  # 只有有漲停股票才儲存
            with open(snapshot_file, 'w', encoding='utf-8') as f:
                json.dump(limit_stocks, f, ensure_ascii=False, indent=2)

            print(f"  SUCCESS: {date_str}.json: {limit_count} 支漲停股票")
            generated_count += 1
        else:
            print(f"  - {date_str}: 無漲停股票")

    print(f"\n=== 生成完成 ===")
    print(f"成功生成: {generated_count} 個 snapshot 檔案")
    print(f"輸出目錄: {SNAPSHOT_DIR}")

    return generated_count

def main():
    """主程式"""
    if len(sys.argv) < 2:
        print("使用方式:")
        print("  python script.py 2026     # 2026年至今")
        print("  python script.py 30       # 最近30天")
        print("  python script.py 2025-01-01 2025-12-31  # 指定日期範圍")
        sys.exit(1)

    arg = sys.argv[1]
    start_date = None
    end_date = None

    try:
        if arg == "2026":
            # 2026年至今
            start_date = "2026-01-01"
            end_date = datetime.now().strftime('%Y-%m-%d')
            print(f"模式: 2026年至今 ({start_date} ~ {end_date})")

        elif arg.isdigit():
            # 最近 N 天
            days = int(arg)
            end_date = datetime.now().strftime('%Y-%m-%d')
            start_date = (datetime.now() - pd.Timedelta(days=days)).strftime('%Y-%m-%d')
            print(f"模式: 最近 {days} 天 ({start_date} ~ {end_date})")

        else:
            # 自定義日期範圍
            start_date = sys.argv[1]
            end_date = sys.argv[2] if len(sys.argv) > 2 else datetime.now().strftime('%Y-%m-%d')
            print(f"模式: 自定義範圍 ({start_date} ~ {end_date})")

        # 執行生成
        count = generate_snapshots(start_date, end_date)

        if count > 0:
            print(f"\nSUCCESS! 現在可以用 generate.mjs 重新生成網站頁面了！")
            print(f"指令: cd D:/claude-auto/usagi-limit && node generate.mjs")
        else:
            print(f"\nWARNING: 沒有生成新的 snapshot 檔案（可能都已存在）")

    except Exception as e:
        print(f"錯誤: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()