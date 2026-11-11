"""Standard control contracts; no user applications are touched."""
import sys
import ctypes
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hidden'))
import controls


class ControlTests(unittest.TestCase):
    def test_replace_text_uses_edit_events_and_checks_readback(self):
        a,b=self.env('RichEditD2DPT',4)
        with a,b,patch.object(controls.winio,'_get_window_text',side_effect=['old','new']),patch.object(controls.winio,'_send_timeout') as send:
            result=controls.run(1,'replace_text','new')
            self.assertTrue(result['verified'])
            self.assertEqual(result['application_commit'],'not_verified')
            self.assertEqual([c.args[1] for c in send.call_args_list],[0xB1,0xC2])

    def test_replace_rejects_readonly_and_wrong_classes_before_mutation(self):
        for kind,style in [('Edit',0x800),('CustomCanvas',0),('Button',0)]:
            a,b=self.env(kind,style)
            with a,b,patch.object(controls.winio,'_send_timeout') as send:
                with self.assertRaisesRegex(ValueError,'UNSUPPORTED_CONTROL'):
                    controls.run(1,'replace_text','new')
                send.assert_not_called()

    def setUp(self):
        self.patches = [patch.object(controls.winio.user32, 'IsWindowEnabled', return_value=1),
                        patch.object(controls.winio.user32, 'GetParent', return_value=2),
                        patch.object(controls.winio.user32, 'GetDlgCtrlID', return_value=7)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def env(self, kind, style):
        return patch.object(controls.winio, '_get_class_name', return_value=kind), patch.object(controls.winio.user32, 'GetWindowLongW', return_value=style)

    def test_checkbox_already_checked_has_no_click(self):
        a,b=self.env('Button',3)
        with a,b,patch.object(controls.winio, '_send_timeout', return_value=1) as send:
            result=controls.run(1,'check')
            self.assertTrue(result['verified'])
            self.assertFalse(result['changed'])
            self.assertEqual([c.args[1] for c in send.call_args_list],[0xF0,0xF0])

    def test_checkbox_sends_event_and_verifies(self):
        a,b=self.env('WindowsForms10.BUTTON.app.0.test',2)
        with a,b,patch.object(controls.winio, '_send_timeout', side_effect=[0,0,1]) as send:
            self.assertTrue(controls.run(1,'check')['verified'])
            self.assertEqual(send.call_args_list[1].args,(1,0xF5,0,0))

    def test_pushbutton_never_treated_as_checkbox(self):
        a,b=self.env('BUTTON',0)
        with a,b,patch.object(controls.winio, '_send_timeout') as send:
            with self.assertRaisesRegex(ValueError,'UNSUPPORTED_CONTROL'):
                controls.run(1,'check')
            send.assert_not_called()

    def test_selection_notifies_parent(self):
        a,b=self.env('COMBOBOX',3)
        with a,b,patch.object(controls.winio, '_send_timeout', side_effect=[3,0,2,0,2]) as send:
            self.assertTrue(controls.run(1,'select',2)['verified'])
            self.assertEqual(send.call_args_list[3].args,(2,0x111,(1<<16)|7,1))

    def test_three_state_style_binary_value_uses_one_click_only(self):
        a,b=self.env('BUTTON',5)
        with a,b,patch.object(controls.winio, '_send_timeout', side_effect=[0,0,1]) as send:
            self.assertTrue(controls.run(1,'check')['verified'])
            self.assertEqual([c.args[1] for c in send.call_args_list].count(0xF5),1)

    def test_three_state_cycle_to_indeterminate_is_failed_not_retried(self):
        a,b=self.env('BUTTON',6)
        with a,b,patch.object(controls.winio, '_send_timeout', side_effect=[1,0,2]) as send:
            self.assertEqual(controls.run(1,'uncheck')['status'],'verification_failed')
            self.assertEqual(send.call_count,3)

    def test_initial_indeterminate_is_rejected_before_click(self):
        a,b=self.env('BUTTON',5)
        with a,b,patch.object(controls.winio, '_send_timeout', return_value=2) as send:
            with self.assertRaisesRegex(ValueError,'indeterminate'):
                controls.run(1,'check')
            self.assertEqual(send.call_count,1)

    def test_radio_button_is_rejected(self):
        a,b=self.env('BUTTON',4)
        with a,b,patch.object(controls.winio, '_send_timeout') as send:
            with self.assertRaisesRegex(ValueError,'UNSUPPORTED_CONTROL'):
                controls.run(1,'check')
            send.assert_not_called()

    def test_selection_out_of_bounds_never_sets(self):
        a,b=self.env('LISTBOX',0)
        with a,b,patch.object(controls.winio, '_send_timeout', return_value=2) as send:
            with self.assertRaisesRegex(ValueError,'INVALID_INDEX'):
                controls.run(1,'select',2)
            self.assertEqual(send.call_count,1)

    def test_multiselect_not_supported(self):
        a,b=self.env('LISTBOX',0x800)
        with a,b:
            with self.assertRaisesRegex(ValueError,'UNSUPPORTED_CONTROL'):
                controls.run(1,'select',0)

    def test_scroll_reports_observation_without_false_completion(self):
        a,b=self.env('EDIT',4)
        with a,b,patch.object(controls.winio, '_send_timeout', side_effect=[0,1,0]):
            result=controls.run(1,'scroll',-10)
            self.assertFalse(result['changed'])
            self.assertFalse(result['verified'])

    def test_scroll_rejects_unbounded_and_single_line(self):
        a,b=self.env('EDIT',0)
        with a,b:
            for value in [101,0,True]:
                with self.assertRaisesRegex(ValueError,'INVALID_ARGUMENT'):
                    controls.run(1,'scroll',value)
            with self.assertRaisesRegex(ValueError,'UNSUPPORTED_CONTROL'):
                controls.run(1,'scroll',1)

    def test_disabled_control_rejected(self):
        a,b=self.env('BUTTON',3)
        with a,b,patch.object(controls.winio.user32,'IsWindowEnabled',return_value=0):
            with self.assertRaisesRegex(ValueError,'CONTROL_DISABLED'):
                controls.run(1,'check')

    def test_selection_readback_failure_is_explicit(self):
        a,b=self.env('COMBOBOX',3)
        with a,b,patch.object(controls.winio,'_send_timeout',side_effect=[3,0,2,0,0]):
            self.assertEqual(controls.run(1,'select',2)['status'],'verification_failed')


class ScreenPointTests(unittest.TestCase):
    def setUp(self):
        self.rects={1:(0,0,400,300),2:(40,40,200,200),3:(60,60,100,100)}
        self.children=[2,3]
        self.hidden=set()
        self.client=(0,0,40,40)
        self.enumerated=0
        def rectangle(handle,pointer):
            value=ctypes.cast(pointer,ctypes.POINTER(controls.wintypes.RECT)).contents
            value.left,value.top,value.right,value.bottom=self.rects.get(int(handle),(0,0,400,300))
            return 1
        def client_rect(handle,pointer):
            value=ctypes.cast(pointer,ctypes.POINTER(controls.wintypes.RECT)).contents
            value.left,value.top,value.right,value.bottom=self.client
            return 1
        def to_client(handle,pointer):
            point=ctypes.cast(pointer,ctypes.POINTER(controls.wintypes.POINT)).contents
            point.x-=60
            point.y-=60
            return 1
        def enumerate_children(root,callback,unused):
            for child in self.children:
                self.enumerated+=1
                if not callback(child,0):
                    return 0
            return 1
        def hit_test(parent,point,flags):
            self.assertEqual(flags,5)
            child={1:2,2:3}.get(parent,parent)
            return parent if child in self.hidden else child
        specs={'SetThreadDpiAwarenessContext':{'return_value':99},
               'GetWindowDpiAwarenessContext':{'return_value':88},
               'GetAwarenessFromDpiAwarenessContext':{'return_value':2},
               'PhysicalToLogicalPointForPerMonitorDPI':{'return_value':1},
               'IsWindowVisible':{'side_effect':lambda h:int(h) not in self.hidden},
               'GetParent':{'side_effect':lambda h:{2:1,3:2}.get(h,1)},
               'ChildWindowFromPointEx':{'side_effect':hit_test},
               'IsChild':{'return_value':1}, 'GetWindowRect':{'side_effect':rectangle},
               'GetClientRect':{'side_effect':client_rect}, 'ScreenToClient':{'side_effect':to_client},
               'EnumChildWindows':{'side_effect':enumerate_children}}
        self.mocks={}
        for name,kw in specs.items():
            p=patch.object(controls.winio.user32,name,**kw)
            self.mocks[name]=p.start()
            self.addCleanup(p.stop)

    def test_descends_hit_test_and_restores_dpi_context(self):
        self.assertEqual(controls.map_screen_point(1,80,80),{'hwnd':3,'x':20,'y':20})
        self.mocks['SetThreadDpiAwarenessContext'].assert_called_with(99)
        self.mocks['PhysicalToLogicalPointForPerMonitorDPI'].assert_not_called()

    def test_dpi_unaware_target_converts_physical_point(self):
        self.mocks['GetAwarenessFromDpiAwarenessContext'].return_value=0
        controls.map_screen_point(1,80,80)
        self.assertEqual(self.mocks['PhysicalToLogicalPointForPerMonitorDPI'].call_args.args[0],3)

    def test_invalid_points_rejected_before_native_calls(self):
        for x,y in [(True,1),(2**31,1),(-2**31-1,0),(1.2,1)]:
            with self.subTest(x=x,y=y),self.assertRaisesRegex(ValueError,'INVALID_ARGUMENT'):
                controls.map_screen_point(1,x,y)
        self.mocks['SetThreadDpiAwarenessContext'].assert_not_called()

    def test_outside_root_never_hit_tests(self):
        with self.assertRaisesRegex(ValueError,'POINT_OUTSIDE_WINDOW'):
            controls.map_screen_point(1,400,50)
        self.mocks['ChildWindowFromPointEx'].assert_not_called()
        self.mocks['SetThreadDpiAwarenessContext'].assert_called_with(99)

    def test_nonclient_point_rejected(self):
        self.client=(0,0,10,10)
        with self.assertRaisesRegex(ValueError,'POINT_OUTSIDE_WINDOW'):
            controls.map_screen_point(1,80,80)
        self.mocks['SetThreadDpiAwarenessContext'].assert_called_with(99)

    def test_hidden_child_is_ignored(self):
        self.hidden={3}
        self.assertEqual(controls.map_screen_point(1,80,80)['hwnd'],2)

    def test_child_limit_stops_enumeration_and_rejects_partial_tree(self):
        self.children=list(range(2,1000))
        with self.assertRaisesRegex(ValueError,'CONTROL_LIMIT'):
            controls.map_screen_point(1,80,80)
        self.assertEqual(self.enumerated,501)
        self.mocks['ScreenToClient'].assert_not_called()

    def test_reparented_child_rejected(self):
        self.mocks['IsChild'].return_value=0
        with self.assertRaisesRegex(ValueError,'STALE_WINDOW'):
            controls.map_screen_point(1,80,80)
        self.assertEqual(self.mocks['ScreenToClient'].call_count,1)

    def test_overlapping_wrappers_use_z_order_not_handle_or_area(self):
        # Both wrappers have identical bounds; the native hit test identifies
        # the front one regardless of numeric HWND or enumeration order.
        self.rects[2]=self.rects[99]=(0,0,400,300)
        self.mocks['ChildWindowFromPointEx'].side_effect=lambda parent,point,flags:99
        for order in ([2,99],[99,2]):
            self.children=order
            self.assertEqual(controls.map_screen_point(1,80,80)['hwnd'],99)
        self.mocks['GetWindowRect'].assert_not_called()

    def test_child_from_different_parent_rejected(self):
        self.mocks['GetParent'].side_effect=None
        self.mocks['GetParent'].return_value=999
        with self.assertRaisesRegex(ValueError,'STALE_WINDOW'):
            controls.map_screen_point(1,80,80)

    def test_cyclic_hit_test_rejected(self):
        self.mocks['ChildWindowFromPointEx'].side_effect=lambda parent,point,flags:2 if parent==1 else 1
        self.mocks['GetParent'].side_effect=lambda child:1 if child==2 else 2
        with self.assertRaisesRegex(ValueError,'cyclic'):
            controls.map_screen_point(1,80,80)

    def test_mixed_dpi_children_start_from_original_physical_point(self):
        physical_inputs=[]
        def convert(handle,pointer):
            point=ctypes.cast(pointer,ctypes.POINTER(controls.wintypes.POINT)).contents
            physical_inputs.append((handle,point.x,point.y))
            point.x+=5
            point.y+=5
            return 1
        self.mocks['GetAwarenessFromDpiAwarenessContext'].side_effect=[2,0,1]
        self.mocks['PhysicalToLogicalPointForPerMonitorDPI'].side_effect=convert
        self.assertEqual(controls.map_screen_point(1,80,80),{'hwnd':3,'x':25,'y':25})
        self.assertEqual(physical_inputs,[(2,80,80),(3,80,80)])

    def test_tree_growth_cannot_exceed_depth_budget(self):
        self.mocks['ChildWindowFromPointEx'].side_effect=lambda parent,point,flags:parent+1
        self.mocks['GetParent'].side_effect=lambda child:child-1
        with self.assertRaisesRegex(ValueError,'CONTROL_LIMIT'):
            controls.map_screen_point(1,80,80)
        self.assertEqual(self.mocks['ChildWindowFromPointEx'].call_count,501)


if __name__ == '__main__':
    unittest.main()
